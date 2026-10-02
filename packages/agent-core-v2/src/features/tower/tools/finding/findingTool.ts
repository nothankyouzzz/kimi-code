import { IAgentScopeContext, agentContextOfScope } from '#/agent/scopeContext/scopeContext';
import { IAgentTowerService } from '#/features/tower/tower';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { TowerProtocolError, slugify } from '#/features/tower/protocol/index';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { callerName, callerTokens, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './finding.md?raw';
import {
  ITowerFindingTool,
  TowerFindingToolInputSchema,
  type TowerFindingToolInput,
} from './finding';

export class TowerFindingTool implements ITowerFindingTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerFinding' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerFindingToolInputSchema);

  constructor(
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionUsageService private readonly usage: ISessionUsageService,
  ) {}

  resolveExecution(args: TowerFindingToolInput): ToolExecution {
    const isSettling = args.file !== undefined;
    return {
      description: isSettling
        ? `Settling tower finding: ${args.disposition ?? 'update'}`
        : `Filing tower ${args.type ?? 'finding'}: ${args.title ?? 'untitled'}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.tower);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);

          const hasFilingFields =
            args.type !== undefined ||
            args.title !== undefined ||
            args.summary !== undefined ||
            args.details !== undefined ||
            args.suggested_fix !== undefined ||
            args.severity !== undefined ||
            args.location !== undefined;

          if (isSettling) {
            if (hasFilingFields) {
              throw new TowerProtocolError(
                'cannot pass "file" together with finding fields (type, title, summary, details, suggested_fix) — pass "file" and "disposition" to settle an existing finding, or omit "file" to file a new finding',
              );
            }
            if (args.disposition === undefined) {
              throw new TowerProtocolError(
                'disposition (assigned | backlogged | dismissed) is required when settling a finding',
              );
            }
            const findings = await store.listFindings();
            const matched = findings.find(
              (f) =>
                f.file === args.file ||
                f.file.endsWith(`/${args.file}`) ||
                f.file.endsWith(`/${args.file}.md`) ||
                (f.title !== undefined && slugify(f.title) === args.file),
            );
            if (matched === undefined) {
              throw new TowerProtocolError(
                `no finding matches "${args.file}" — pass a file from TowerStatus or a title slug`,
              );
            }
            await store.setFindingDisposition(matched.file, { status: args.disposition, note: args.note });
            return {
              output: `finding disposition updated: ${matched.file} -> ${args.disposition}${args.note !== undefined ? ` (${args.note})` : ''}`,
            };
          }

          if (!args.type || !args.title || !args.summary || !args.details || !args.suggested_fix) {
            throw new TowerProtocolError(
              'type, title, summary, details, and suggested_fix are required when filing a finding; or pass "file" and "disposition" to settle an existing finding',
            );
          }

          const rel = await store.fileFinding(caller, {
            type: args.type,
            title: args.title,
            severity: args.severity,
            summary: args.summary,
            location: args.location,
            details: args.details,
            suggestedFix: args.suggested_fix,
            tokens: callerTokens(this.usage, agentContextOfScope(this.scopeContext)),
          });

          if (args.disposition !== undefined) {
            await store.setFindingDisposition(rel, { status: args.disposition, note: args.note });
            return {
              output: `finding filed: ${rel} (disposition: ${args.disposition})\nThe tower will route it — do not fix out-of-scope issues yourself.`,
            };
          }

          return {
            output: `finding filed: ${rel}\nThe tower will route it — do not fix out-of-scope issues yourself.`,
          };
        }),
    };
  }
}

