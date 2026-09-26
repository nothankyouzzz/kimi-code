import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerFindingToolInputSchema = z
  .object({
    file: z
      .string()
      .optional()
      .describe('Finding file path or title slug to settle (when updating disposition)'),
    disposition: z
      .enum(['assigned', 'backlogged', 'dismissed'])
      .optional()
      .describe('Disposition status: assigned | backlogged | dismissed'),
    note: z.string().optional().describe('Disposition note explaining the triage decision'),
    type: z.enum(['bug', 'improve', 'vuln', 'idea']).optional().describe('Finding category'),
    title: z.string().optional().describe('Short finding title'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    summary: z.string().optional().describe('What was found, in a sentence or two'),
    location: z.string().optional().describe('File/symbol the finding concerns'),
    details: z.string().optional().describe('Full details: evidence, reproduction, impact'),
    suggested_fix: z.string().optional().describe('What you would do about it'),
  })
  .strict();

export type TowerFindingToolInput = z.infer<typeof TowerFindingToolInputSchema>;

export interface ITowerFindingTool extends AgentTool<TowerFindingToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerFindingTool = createDecorator<ITowerFindingTool>('towerFindingTool');
