import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTowerService } from '#/features/tower/tower';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './inbox.md?raw';
import { ITowerInboxTool, TowerInboxToolInputSchema, type TowerInboxToolInput } from './inbox';

const DEFAULT_LIMIT = 20;

export class TowerInboxTool implements ITowerInboxTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerInbox' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerInboxToolInputSchema);

  constructor(
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: TowerInboxToolInput): ToolExecution {
    return {
      description: 'Reading tower inbox',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.tower);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          const total = await store.countVisibleInbox(caller);
          const items = await store.readInbox(caller, {
            limit: args.limit ?? DEFAULT_LIMIT,
            offset: args.offset,
            before: args.before,
            since: args.since,
          });
          await store.markInboxRead(caller, items[0]?.sentAt);
          if (items.length === 0) {
            return {
              output:
                total === 0
                  ? `inbox empty for ${caller}`
                  : `0 of ${String(total)} message(s) for ${caller}`,
            };
          }
          const sections = items.map((item) =>
            [
              `file: ${item.file}`,
              `from: ${item.from}`,
              `to: ${item.to}`,
              `subject: ${item.subject}`,
              `sent_at: ${item.sentAt}`,
              ...(item.scope !== undefined ? [`scope: ${item.scope}`] : []),
              '',
              item.body,
            ].join('\n'),
          );
          return {
            output: [
              `${String(items.length)} of ${String(total)} message(s) for ${caller} (newest first):`,
              '',
              sections.join('\n\n---\n\n'),
            ].join('\n'),
          };
        }),
    };
  }
}

