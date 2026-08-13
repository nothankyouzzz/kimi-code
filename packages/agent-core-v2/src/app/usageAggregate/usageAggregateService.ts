/**
 * `usageAggregate` domain — `IUsageAggregateService` implementation.
 *
 * Enumerates the persisted session set through the session index, derives
 * each session's directory from the handler-chain addressing, and folds
 * every `usage.record` Op in the window via the domain's wire scanner.
 * Per-session scan failures degrade to a logged warning so one corrupted
 * session never sinks the whole aggregate. Bound at App scope.
 */

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { addUsage, type TokenUsage } from '#/kosong/contract/usage';
import {
  sessionDirOf,
  workspacePersistenceScope,
} from '#/workspace/sessionLifecycle/internal/addressing';

import { IUsageAggregateService, type UsageAggregate } from './usageAggregate';
import { scanSessionUsage } from './usage-scan';

export class UsageAggregateService implements IUsageAggregateService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionIndex private readonly index: ISessionIndex,
    @ILogService private readonly log: ILogService,
  ) {}

  async aggregate(sinceMs: number): Promise<UsageAggregate> {
    const byModel: Record<string, TokenUsage> = {};
    let sessionsScanned = 0;

    const sessionsScope = this.bootstrap.scope('sessions');
    // Archived sessions still burned quota inside the window, so they count.
    const page = await this.index.listRecent({ includeArchived: true });
    for (const summary of page.items) {
      const sessionDir = sessionDirOf(
        this.bootstrap.homeDir,
        workspacePersistenceScope(sessionsScope, summary.workspaceId),
        summary.id,
      );
      try {
        const scan = await scanSessionUsage(sessionDir, sinceMs);
        if (!scan.matched) continue;
        sessionsScanned += 1;
        for (const [model, usage] of Object.entries(scan.byModel)) {
          const current = byModel[model];
          byModel[model] = current === undefined ? usage : addUsage(current, usage);
        }
      } catch (error) {
        this.log.warn('usage aggregate: session scan failed', {
          error: String(error),
          sessionId: summary.id,
        });
      }
    }

    return { since: sinceMs, byModel, sessionsScanned };
  }
}

registerScopedService(
  LifecycleScope.App,
  IUsageAggregateService,
  UsageAggregateService,
  ScopeActivation.OnDemand,
  'usageAggregate',
);
