import {
  GitError,
  TowerProtocolError,
  TowerStore,
  type TowerState,
} from '#/features/tower/protocol/index';
import type { IAgentTowerService } from '#/features/tower/tower';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { grandTotal } from '#human/llm/usage';

export function newTowerStore(tower: IAgentTowerService): TowerStore {
  return new TowerStore(tower.workspaceRoot);
}

export const TOWER_MAIN_AGENT_ONLY =
  'Tower orchestration tools are only supported by the main agent.';

export const TOWER_MODE_USER_ENABLED_ONLY =
  'tower mode is not active — only the user can enable it (with /tower on [dir]), never the agent. ' +
  'Ask the user to turn tower mode on, then drive the tower protocol.';

export function callerName(agentId: string, store: TowerStore, state: TowerState): string {
  return store.resolveCallerName(state, agentId);
}

export function callerTokens(
  usage: ISessionUsageService | undefined,
  agent: AgentContext,
): number {
  const total = usage?.status(agent).total;
  return total === undefined ? -1 : grandTotal(total);
}

export async function runTowerTool(
  execute: () => Promise<ExecutableToolResult>,
): Promise<ExecutableToolResult> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof TowerProtocolError || error instanceof GitError) {
      return { output: error.message, isError: true };
    }
    throw error;
  }
}
