/**
 * `usageAggregate` domain — cross-session token usage aggregation contract.
 *
 * Folds every persisted `usage.record` Op across all sessions (any workspace,
 * open or archived, live or cold) into per-model totals for a time window.
 * The consumer is the `/usage` report, which prices the current weekly
 * subscription window at API list rates. Bound at App scope: the aggregate
 * has no per-session identity, it is a process-wide read over durable state.
 *
 * The scan is durable-only: records still buffered in a live agent's append
 * log are invisible until flushed, so the result is a lower-bound estimate.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface UsageAggregate {
  /** Inclusive window start (epoch ms) the totals were folded from. */
  readonly since: number;
  /** Per-model token totals recorded at or after `since`. */
  readonly byModel: Record<string, TokenUsage>;
  /** Number of session directories that contributed at least one record. */
  readonly sessionsScanned: number;
}

export interface IUsageAggregateService {
  readonly _serviceBrand: undefined;

  /**
   * Fold all persisted `usage.record` ops with `time >= sinceMs` across every
   * session in the local sessions store, grouped by model.
   */
  aggregate(sinceMs: number): Promise<UsageAggregate>;
}

export const IUsageAggregateService: ServiceIdentifier<IUsageAggregateService> =
  createDecorator<IUsageAggregateService>('usageAggregateService');
