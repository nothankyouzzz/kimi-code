import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerInboxToolInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max messages to return (default 20), newest first'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of messages to skip (for paging older messages)'),
    before: z
      .string()
      .optional()
      .describe('Return only messages sent before this ISO timestamp'),
    since: z
      .string()
      .optional()
      .describe('Return only messages sent since/after this ISO timestamp'),
  })
  .strict();

export type TowerInboxToolInput = z.infer<typeof TowerInboxToolInputSchema>;

export interface ITowerInboxTool extends AgentTool<TowerInboxToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerInboxTool = createDecorator<ITowerInboxTool>('towerInboxTool');
