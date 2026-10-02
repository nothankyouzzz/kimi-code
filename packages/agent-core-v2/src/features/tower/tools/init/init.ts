import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerInitToolInputSchema = z
  .object({
    base: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Local branch that missions fork from and merge back into (e.g. "develop"). Defaults to the branch currently checked out in the main worktree. Remote-tracking refs (e.g. "origin/main") and tags are not accepted — create a local branch first.',
      ),
    dir: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Root directory of an existing git work tree to use for the tower. Defaults to the session workspace. The directory must already be a git work tree; tower never runs git init on a directory picked explicitly.',
      ),
  })
  .strict();

export type TowerInitToolInput = z.infer<typeof TowerInitToolInputSchema>;

export interface ITowerInitTool extends AgentTool<TowerInitToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerInitTool = createDecorator<ITowerInitTool>('towerInitTool');
