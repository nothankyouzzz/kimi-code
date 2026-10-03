import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAbsolute, normalize, resolve } from 'pathe';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService, type LoopNotifyHandle } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { PromptSubmitted } from '#/agent/prompt/promptEvents';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { AgentTaskInfo } from '#/agent/task/types';
import { TaskTerminatedNotice } from '#/agent/task/taskOps';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';
import { IConfigService } from '#/app/config/config';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { IFeatureManager } from '#/app/feature/featureManager';
import { LifecycleScope } from '#/app/scopes';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { isWithinDirectory } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import { isUntitled } from '#/session/sessionMetadata/promptMetadata';
import { SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { TowerModeInjection } from './injection/towerModeInjection';
import {
  BROADCAST_NAME,
  TOWER_NAME,
  TowerStore,
  WORKTREES_DIR,
  assertLocalBaseBranch,
  branchExists,
  checkoutNewLocalBranch,
  commitPaths,
  isInsideRepo,
  listBaseDirtyEntries,
  resolveTowerRepoRoot,
  TowerProtocolError,
} from './protocol/index';
import { TOWER_MODE_USER_ENABLED_ONLY } from './tools/support';
import {
  IAgentTowerService,
  TOWER_FLAG_ID,
  TOWER_TOOL_NAMES,
  TOWER_WORKER_PROFILE,
  type TowerEnterResult,
  type TowerExitReason,
} from './tower';
import { isTowerFeatureAssembled } from './towerFeature';
import { TowerInboxSent, TowerModeEnter, TowerModeExit, TowerWorkspaceAdopted, towerBaseKey, towerDirKey, towerKey, towerOwnerKey, towerWorkspaceKey } from './towerOps';
import { evaluateWorkerBashCommand } from './workerShellGuard';

export const TOWER_MODE_TOOLS: readonly string[] = ['TowerInit', ...TOWER_TOOL_NAMES];

export const TOWER_ORCHESTRATION_TOOLS: readonly string[] = [
  'TowerInit',
  'TowerPlan',
  'TowerSpawn',
  'TowerMerge',
  'TowerTeardown',
];

export const TOWER_INBOX_WAKE_VARIANT = 'tower_inbox';

const WAKE_SUBJECT_PREVIEW_MAX = 120;

export class AgentTowerService extends Disposable implements IAgentTowerService {
  declare readonly _serviceBrand: undefined;
  private readonly bashParser: IBashParserService;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IFlagService private readonly flags: IFlagService,
    @ISessionManager private readonly sessions: ISessionManager,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IFeatureManager featureManager: IFeatureManager,
    @IConfigService config: IConfigService,
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentContextMemoryService context: IAgentContextMemoryService,
    @IEventBus eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @ISessionEventBus sessionBus: ISessionEventBus,
    @IBashParserService bashParser?: IBashParserService,
    @ISessionMetadata private readonly sessionMeta?: ISessionMetadata,
  ) {
    super();
    this.bashParser = bashParser ?? new BashParserService();
    this.agentState.contributeState(towerKey);
    this.agentState.contributeState(towerOwnerKey);
    this.agentState.contributeState(towerBaseKey);
    this.agentState.contributeState(towerDirKey);
    this.agentState.contributeState(towerWorkspaceKey);
    this._register(
      this.dispatcher.hooks.onDidRestore.register('tower', async (_ctx, next) => {
        await this.reconcileForeignTower();
        this.restoreTowerTools();
        this.reconcileTowerProjection();
        await next();
      }),
    );
    if (featureManager !== undefined) {
      this._register(
        featureManager.onDidChangeUnits(() => {
          this.reconcileTowerProjection();
        }),
      );
    }
    if (config !== undefined) {
      this._register(
        config.onDidChangeConfiguration(() => {
          this.reconcileTowerProjection();
        }),
      );
    }
    this._register(
      eventBus.subscribe(AgentStatusUpdated, () => {
        if (this.agentCtx.agentId !== 'main') return;
        if (!this.isActive) return;
        const active = this.profile.getActiveToolNames();
        if (active === undefined) return;
        if (TOWER_MODE_TOOLS.every((name) => active.includes(name))) return;
        for (const name of TOWER_MODE_TOOLS) this.profile.addActiveTool(name);
        void this.dispatcher.dispatch(
          new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: true }),
        );
      }),
    );
    this._register(new TowerModeInjection(reminder, this, context, this.flags));
    this._register(
      eventBus.subscribe(TaskTerminatedNotice, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        void this.recordTowerAgentDeath(event.info);
      }),
    );
    this._register(
      eventBus.subscribe(SubagentStarted, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        void this.clearTowerAgentDeath(event.subagentId);
      }),
    );
    if (sessionBus !== undefined) {
      this._register(
        sessionBus.subscribe(TowerInboxSent, (event) => {
          this.onTowerInboxSent(event);
        }),
      );
    }
    this._register(
      eventBus.subscribe(TurnStarted, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        if (!this.isActive) return;
        if (event.agentId !== this.agentCtx.agentId) return;
        if (event.origin.kind !== 'injection' || event.origin.variant !== TOWER_INBOX_WAKE_VARIANT) {
          return;
        }
        this.wakeTurnId = event.turnId;
      }),
    );
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        if (event.agentId !== this.agentCtx.agentId) return;
        if (event.turnId === this.wakeTurnId) {
          this.wakeTurnId = undefined;
          return;
        }
        if (!this.wakeAbortedForUserPrompt) return;
        if (this.loop === undefined || this.loop.snapshot().queue.length > 0) return;
        this.wakeAbortedForUserPrompt = false;
        this.inboxWakeSignals = Math.max(this.inboxWakeSignals, 1);
        this.scheduleInboxWake();
      }),
    );
    this._register(
      eventBus.subscribe(PromptSubmitted, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        if (!this.isActive) return;
        if (event.agentId !== this.agentCtx.agentId) return;
        const turnId = this.wakeTurnId;
        if (turnId === undefined) return;
        queueMicrotask(() => {
          if (this.wakeDisposed || !this.isActive || this.loop === undefined) return;
          if (this.loop.cancel({ turnId }, userCancellationReason())) {
            this.wakeAbortedForUserPrompt = true;
          }
        });
      }),
    );
    this._register(
      toDisposable(() => {
        this.wakeDisposed = true;
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!TOWER_MODE_TOOLS.includes(event.toolCall.name)) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'The tower experiment is disabled — tower tools are inert. Re-enable the experiment (a restart is required if it was just turned on) before driving the tower protocol.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
        if (this.isActive) return;
        if (!TOWER_ORCHESTRATION_TOOLS.includes(event.toolCall.name)) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(TOWER_MODE_USER_ENABLED_ONLY),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!this.isActive) return;
        if (event.toolCall.name !== 'TodoList') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'TodoList is not available while tower mode is active — mission state lives in the tower protocol (TowerPlan/TowerMission/TowerStatus, MISSIONS.md), and todo semantics would serialize the fleet. Spawn every dependency-unblocked mission now, then end your turn: worker completions wake you.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!this.isActive) return;
        if (event.toolCall.name !== 'AgentSwarm') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'AgentSwarm is not available while tower mode is active — swarm and tower modes are mutually exclusive, and the tower fleet runs through TowerSpawn, one mission per worker in its own worktree. If the work genuinely needs a swarm instead, exit tower mode first.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!this.isActive) return;
        if (event.toolCall.name !== 'Agent') return;
        const args = event.args;
        if (typeof args !== 'object' || args === null) return;
        const resume = (args as { readonly resume?: unknown }).resume;
        if (typeof resume !== 'string') return;
        const resumeId = resume.trim();
        if (resumeId.length === 0) return;
        if ((args as { readonly run_in_background?: unknown }).run_in_background === true) return;
        const backgroundAvailable =
          this.toolPolicy.isToolActive('TaskList') &&
          this.toolPolicy.isToolActive('TaskOutput') &&
          this.toolPolicy.isToolActive('TaskStop');
        if (!backgroundAvailable) return;
        const store = new TowerStore(this.workspaceRoot);
        const entry = await store
          .load()
          .then(
            (state) => store.resolveAgent(state, resumeId),
            () => undefined,
          );
        if (entry === undefined) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              `Resuming tower agent "${entry.name}" in the foreground would freeze the tower until it finishes — pass run_in_background=true instead; its completion (and any inbox traffic) will wake you.`,
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        const toolName = event.toolCall.name;
        if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'Bash') return;

        const store = new TowerStore(this.workspaceRoot);
        const state = await store.load().catch(() => undefined);
        if (state === undefined) return;

        let entry: ReturnType<typeof store.resolveAgent> | undefined;
        if (this.profile.data().profileName === TOWER_WORKER_PROFILE) {
          entry = store.resolveAgent(state, this.agentCtx.agentId);
        } else if (this.sessionMeta !== undefined) {
          try {
            const meta = await this.sessionMeta.read();
            let currentId: string | undefined = this.agentCtx.agentId;
            const seen = new Set<string>();
            while (currentId !== undefined && !seen.has(currentId)) {
              seen.add(currentId);
              const parentId: string | undefined = subagentParentAgentId(meta.agents?.[currentId]);
              if (parentId === undefined) break;
              entry = store.resolveAgent(state, parentId);
              if (entry !== undefined) break;
              currentId = parentId;
            }
          } catch {}
        }
        if (entry === undefined) return;

        const slot = entry.worktree;
        if (slot === undefined) return;
        const worktree = store.abs(join(WORKTREES_DIR, slot));

        if (toolName === 'Write' || toolName === 'Edit') {
        const escapes = (event.execution.accesses ?? [])
          .filter(
            (access): access is ToolFileAccess =>
              access.kind === 'file' &&
              (access.operation === 'write' || access.operation === 'readwrite'),
          )
          .filter((access) => !isWithinDirectory(access.path, worktree));
        if (escapes.length === 0) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              `tower workers may only write inside their own worktree (${worktree}) — denied: ` +
                `${escapes.map((access) => access.path).join(', ')}. ` +
                'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.',
            ),
          ),
        );
          return;
        }

        if (toolName === 'Bash') {
          const args = event.args;
          if (typeof args !== 'object' || args === null) return;
          const command = (args as { readonly command?: unknown }).command;
          if (typeof command !== 'string') return;
          const cwdArg = (args as { readonly cwd?: unknown }).cwd;
          const initialCwd =
            typeof cwdArg === 'string' && cwdArg.trim().length > 0
              ? (isAbsolute(cwdArg) ? normalize(cwdArg) : normalize(resolve(this.sessionCtx.cwd, cwdArg)))
              : normalize(this.sessionCtx.cwd);

          const result = evaluateWorkerBashCommand(
            command,
            {
              worktree,
              initialCwd,
              homeDir: process.env['HOME'],
            },
            this.bashParser,
          );
          if (result.allowed) return;
          event.veto(
            denyToolExecution(
              this.toolApproval.formatDenyMessage(
                `tower workers may only write inside their own worktree (${worktree}) — denied: ` +
                  `${result.escapes.join(', ')}. ` +
                  'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.',
              ),
            ),
          );
        }
      }),
    );
  }

  async enter(base?: string, dir?: string): Promise<TowerEnterResult> {
    const result = await this.resolveEnter(base, dir);
    this.telemetry.track2('tower_mode_enter', {
      outcome: result.entered ? 'entered' : 'rejected',
      reason: result.entered ? undefined : result.reason,
    });
    return result;
  }

  private async resolveEnter(base?: string, dir?: string): Promise<TowerEnterResult> {
    if (this.agentCtx.agentId !== 'main') return { entered: false, reason: 'not-main-agent' };
    if (!this.flags.enabled(TOWER_FLAG_ID)) return { entered: false, reason: 'experiment-off' };
    if (!isTowerFeatureAssembled(this.flags)) return { entered: false, reason: 'feature-not-assembled' };
    const resolvedDir = dir !== undefined ? await this.validateUserDir(dir) : undefined;
    const root = resolvedDir ?? this.workspaceRoot;
    if (base !== undefined) {
      await this.prepareUserBase(root, base);
    }
    if (this.isActive) {
      const baseChanged = base !== undefined && base !== this.agentState.get(towerBaseKey);
      const dirChanged = resolvedDir !== undefined && resolvedDir !== this.agentState.get(towerDirKey);
      if (baseChanged || dirChanged) {
        this.dispatchEnter(base, resolvedDir);
      }
      return { entered: true };
    }
    const owner = await this.resolveTowerOwner(root);
    if (owner !== undefined && owner !== this.sessionCtx.sessionId) {
      const ownerHandle = this.sessions.get(owner);
      if (ownerHandle !== undefined) {
        const activity = ownerHandle.accessor.get(ISessionActivityView).state();
        if (activity.busy || activity.pendingInteraction !== 'none') {
          const ownerTitle = await this.resolveOwnerTitle(ownerHandle);
          return { entered: false, reason: 'owned-by-live-session', owner, ownerTitle };
        }
        await ownerHandle.accessor
          .get(IAgentLifecycleService)
          .handleOf('main')
          ?.accessor.get(IAgentTowerService)
          .exit('takeover');
      }
    }
    await this.adoptTowerRoster(root);
    for (const name of TOWER_MODE_TOOLS) this.profile.addActiveTool(name);
    this.lastPublished = true;
    this.dispatchEnter(base, resolvedDir);
    return { entered: true };
  }

  get requestedBase(): string | undefined {
    return this.agentState.get(towerBaseKey) ?? undefined;
  }

  get requestedDir(): string | undefined {
    return this.agentState.get(towerDirKey) ?? undefined;
  }

  get workspaceRoot(): string {
    return this.requestedDir ?? this.agentState.get(towerWorkspaceKey) ?? resolveTowerRepoRoot(this.sessionCtx.cwd);
  }

  adoptWorkspaceRoot(root: string): void {
    void this.dispatcher.dispatch(new TowerWorkspaceAdopted({ agentId: this.agentCtx.agentId, root }));
  }

  private async validateUserDir(dir: string): Promise<string> {
    const trimmed = dir.trim();
    let expanded = trimmed;
    if (trimmed === '~') {
      expanded = homedir();
    } else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
      expanded = resolve(homedir(), trimmed.slice(2));
    }
    const absolutePath = isAbsolute(expanded) ? expanded : resolve(this.sessionCtx.cwd, expanded);
    const root = resolveTowerRepoRoot(resolve(absolutePath));
    const stats = await stat(root).catch((error: unknown) => {
      throw new TowerProtocolError(
        `tower directory "${dir}" (${root}) does not exist: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (!stats.isDirectory()) {
      throw new TowerProtocolError(`tower directory "${dir}" (${root}) is not a directory`);
    }
    if (!(await isInsideRepo(root))) {
      throw new TowerProtocolError(
        `tower directory "${dir}" (${root}) is not inside a git work tree; tower will not run "git init" on an explicitly chosen directory`,
      );
    }
    return root;
  }

  async setWorkspaceDir(dir: string): Promise<string> {
    if (!this.isActive) {
      throw new TowerProtocolError(
        'tower mode is not active — its directory can only be set while the tower runs',
      );
    }
    const root = await this.validateUserDir(dir);
    this.dispatchEnter(this.requestedBase, root);
    return root;
  }

  private async prepareUserBase(repoRoot: string, base: string): Promise<void> {
    const store = new TowerStore(repoRoot);
    await store.ensureRepository(base);
    if (await store.isInitialized()) {
      const state = await store.load();
      if (state.base === base) {
        await assertLocalBaseBranch(repoRoot, base);
        return;
      }
      const open = state.missions.filter(
        (mission) => mission.status !== 'merged' && mission.status !== 'abandoned',
      );
      if (open.length > 0) {
        throw new TowerProtocolError(
          `tower workspace already records base "${state.base}" with ${String(open.length)} open mission(s) (${open.map((mission) => mission.id).join(', ')}) — merge or abandon them (or /tower teardown) before switching the tower to base "${base}"`,
        );
      }
      if (!(await branchExists(repoRoot, base))) {
        await this.createBaseBranch(repoRoot, base);
      }
      await store.rebase(base);
      return;
    }
    if (await branchExists(repoRoot, base)) {
      await store.init(this.sessionCtx.sessionId, base);
      return;
    }
    await this.createBaseBranch(repoRoot, base);
    await store.init(this.sessionCtx.sessionId, base);
  }

  private async createBaseBranch(repoRoot: string, base: string): Promise<void> {
    const dirty = await listBaseDirtyEntries(repoRoot);
    if (dirty.some((entry) => entry.unmerged)) {
      throw new TowerProtocolError(
        'the checkout has unmerged paths (an in-progress merge, rebase, or cherry-pick) — finish or abort it before starting a tower on a new base',
      );
    }
    await checkoutNewLocalBranch(repoRoot, base);
    if (dirty.length === 0) return;
    try {
      await commitPaths(
        repoRoot,
        dirty.map((entry) => entry.path),
        `tower: snapshot of uncommitted base checkout changes (base ${base})`,
      );
    } catch (error) {
      throw new TowerProtocolError(
        `created and switched to "${base}", but committing the checkout's uncommitted changes onto it failed: ${error instanceof Error ? error.message : String(error)}. ` +
          `The changes are still uncommitted on "${base}" — commit or move them, then re-run /tower ${base}.`,
      );
    }
  }

  private dispatchEnter(base?: string, dir?: string): void {
    void this.dispatcher.dispatch(
      new TowerModeEnter({
        agentId: this.agentCtx.agentId,
        sessionId: this.sessionCtx.sessionId,
        base: base ?? this.requestedBase ?? undefined,
        dir: dir ?? this.requestedDir ?? undefined,
      }),
    );
  }

  async exit(reason: TowerExitReason = 'user'): Promise<void> {
    if (!this.agentState.get(towerKey)) return;
    this.lastPublished = false;
    this.dropInboxWake();
    for (const name of TOWER_MODE_TOOLS) this.profile.removeActiveTool(name);
    void this.dispatcher.dispatch(new TowerModeExit({ agentId: this.agentCtx.agentId }));
    this.telemetry.track2('tower_mode_exit', { reason });
    await this.releaseTowerOwnership();
  }

  private dropInboxWake(): void {
    this.inboxWakeHandle?.drop();
    this.inboxWakeHandle = undefined;
    this.inboxWakeSignals = 0;
  }

  private async adoptTowerRoster(root: string = this.workspaceRoot): Promise<void> {
    const store = new TowerStore(root);
    try {
      await store.adopt(this.sessionCtx.sessionId);
    } catch (error) {
      throw new TowerProtocolError(
        `failed to adopt the tower workspace roster: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async releaseTowerOwnership(): Promise<void> {
    const store = new TowerStore(this.workspaceRoot);
    await store.release(this.sessionCtx.sessionId).then(
      () => undefined,
      (error: unknown) => {
        this.log.warn(
          `failed to release tower workspace ownership: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }

  get isActive(): boolean {
    return (
      this.agentCtx.agentId === 'main' &&
      this.flags.enabled(TOWER_FLAG_ID) &&
      isTowerFeatureAssembled(this.flags) &&
      this.agentState.get(towerKey)
    );
  }

  private async reconcileForeignTower(): Promise<void> {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.agentState.get(towerKey)) return;
    const owner = await this.resolveTowerOwner();
    if (owner === undefined || owner === this.sessionCtx.sessionId) return;
    if (this.sessions.get(owner) === undefined) {
      try {
        await this.adoptTowerRoster();
      } catch (error) {
        this.log.warn(
          `failed to adopt tower workspace roster on restore: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.exit('foreign-reconcile');
      }
      return;
    }
    void this.exit('foreign-reconcile');
  }

  private async resolveTowerOwner(root: string = this.workspaceRoot): Promise<string | undefined> {
    const store = new TowerStore(root);
    const storeOwner = await store.load().then(
      (state) => state.sessionId,
      () => undefined,
    );
    return storeOwner ?? this.agentState.get(towerOwnerKey);
  }

  private async resolveOwnerTitle(ownerHandle: ISessionScopeHandle): Promise<string | undefined> {
    try {
      const meta = await ownerHandle.accessor.get(ISessionMetadata).read();
      return isUntitled(meta.title) ? undefined : meta.title;
    } catch {
      return undefined;
    }
  }

  private async recordTowerAgentDeath(info: AgentTaskInfo): Promise<void> {
    if (info.kind !== 'agent') return;
    if (info.agentId === undefined) return;
    if (info.status === 'completed') return;
    if (!this.isActive) return;
    const store = new TowerStore(this.workspaceRoot);
    const foreignOwner = await this.resolveForeignStoreOwner(store);
    if (foreignOwner !== undefined) {
      this.log.info('tower: skipping roster agent death mark — tower store is owned by another session', {
        event: 'TaskTerminatedNotice',
        agentId: info.agentId,
        sessionId: this.sessionCtx.sessionId,
        owner: foreignOwner,
        pid: process.pid,
      });
      return;
    }
    this.log.info('tower: marking roster agent died', {
      event: 'TaskTerminatedNotice',
      agentId: info.agentId,
      taskId: info.taskId,
      status: info.status,
      stopReason: info.stopReason,
      sessionId: this.sessionCtx.sessionId,
      pid: process.pid,
    });
    await store.markAgentDied(info.agentId, info.status, info.stopReason, this.sessionCtx.sessionId).then(
      () => undefined,
      () => undefined,
    );
  }

  private async clearTowerAgentDeath(agentId: string): Promise<void> {
    if (!this.isActive) return;
    const store = new TowerStore(this.workspaceRoot);
    const foreignOwner = await this.resolveForeignStoreOwner(store);
    if (foreignOwner !== undefined) {
      this.log.info('tower: skipping roster agent death clear — tower store is owned by another session', {
        event: 'SubagentStarted',
        agentId,
        sessionId: this.sessionCtx.sessionId,
        owner: foreignOwner,
        pid: process.pid,
      });
      return;
    }
    this.log.info('tower: clearing roster agent death mark', {
      event: 'SubagentStarted',
      agentId,
      sessionId: this.sessionCtx.sessionId,
      pid: process.pid,
    });
    await store.clearAgentDied(agentId, this.sessionCtx.sessionId).then(
      () => undefined,
      () => undefined,
    );
  }

  private async resolveForeignStoreOwner(store: TowerStore): Promise<string | undefined> {
    const owner = await store.load().then(
      (state) => state.sessionId,
      () => undefined,
    );
    return owner !== undefined && owner !== this.sessionCtx.sessionId ? owner : undefined;
  }

  private inboxWakeSignals = 0;
  private inboxWakeLatest: { readonly from: string; readonly subject: string } | undefined;
  private inboxWakeScheduled = false;
  private inboxWakePending = false;
  private inboxWakeHandle: LoopNotifyHandle | undefined;
  private wakeDisposed = false;
  private wakeTurnId: number | undefined;
  private wakeAbortedForUserPrompt = false;

  private onTowerInboxSent(event: TowerInboxSent): void {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.isActive) return;
    if (event.from === TOWER_NAME) return;
    if (event.to !== TOWER_NAME && event.to !== BROADCAST_NAME) return;
    this.inboxWakeSignals += 1;
    this.inboxWakeLatest = { from: event.from, subject: event.subject };
    this.scheduleInboxWake();
  }

  private scheduleInboxWake(): void {
    if (this.inboxWakeScheduled || this.inboxWakePending) return;
    this.inboxWakeScheduled = true;
    queueMicrotask(() => {
      this.flushInboxWake();
    });
  }

  private flushInboxWake(): void {
    this.inboxWakeScheduled = false;
    if (this.wakeDisposed || !this.isActive || this.loop === undefined) {
      this.inboxWakeSignals = 0;
      return;
    }
    const count = this.inboxWakeSignals;
    const latest = this.inboxWakeLatest;
    if (count === 0 || latest === undefined) return;
    this.inboxWakeSignals = 0;
    this.inboxWakePending = true;
    const countText = count === 1 ? '1 new tower inbox message' : `${String(count)} new tower inbox messages`;
    const subject =
      latest.subject.length > WAKE_SUBJECT_PREVIEW_MAX
        ? `${latest.subject.slice(0, WAKE_SUBJECT_PREVIEW_MAX)}…`
        : latest.subject;
    this.inboxWakeHandle = this.loop.notify({
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${countText} — latest from ${latest.from}: "${subject}". Read and route with TowerInbox.`,
          },
        ],
        toolCalls: [],
        origin: { kind: 'injection', variant: TOWER_INBOX_WAKE_VARIANT },
      },
      turnScoped: false,
      onConsume: () => {
        this.inboxWakeHandle = undefined;
        this.inboxWakePending = false;
        if (this.inboxWakeSignals > 0) this.scheduleInboxWake();
      },
      onDrop: () => {
        this.inboxWakeHandle = undefined;
        this.inboxWakePending = false;
      },
    });
  }

  private restoreTowerTools(): void {
    if (!this.flags.enabled(TOWER_FLAG_ID)) return;
    if (!this.isActive) return;
    if (this.agentCtx.agentId !== 'main') return;
    for (const name of TOWER_MODE_TOOLS) this.profile.addActiveTool(name);
    this.lastPublished = true;
    void this.dispatcher.dispatch(new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: true }));
  }

  private lastPublished: boolean | undefined;

  private reconcileTowerProjection(): void {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.agentState.get(towerKey)) {
      this.lastPublished = false;
      return;
    }
    const effective = this.isActive;
    if (!effective) this.dropInboxWake();
    if (this.lastPublished === effective) return;
    this.lastPublished = effective;
    void this.dispatcher.dispatch(
      new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: effective }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTowerService,
  AgentTowerService,
  ScopeActivation.OnScopeCreated,
  'tower',
);
