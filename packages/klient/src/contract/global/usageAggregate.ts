/**
 * `usageAggregateService` — cross-session usage aggregation. Mirrors
 * `agent-core-v2/app/usageAggregate/usageAggregate.ts`.
 */

import { z } from 'zod';

import { tokenUsageSchema } from '../agent/rpc.js';
import type { ServiceContract } from '../types.js';

export const usageAggregateSchema = z.object({
  since: z.number(),
  byModel: z.record(z.string(), tokenUsageSchema),
  sessionsScanned: z.number(),
});

export const usageAggregateContract = {
  aggregate: { input: z.tuple([z.number()]), output: usageAggregateSchema },
} satisfies ServiceContract;
