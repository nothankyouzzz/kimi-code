import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import type { ModelRequester } from '#/llm-adapter/model/model-requester';

import { AUTO_SESSION_TITLE_FLAG_ID } from './flag';

export const SESSION_TITLE_SECTION = 'sessionTitle';

export const SessionTitleConfigSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).optional(),
});

export type SessionTitleConfig = z.infer<typeof SessionTitleConfigSchema>;

registerConfigSection(SESSION_TITLE_SECTION, SessionTitleConfigSchema);

export function isSessionTitleEnabled(config: IConfigService, flags: IFlagService): boolean {
  if (flags.enabled(AUTO_SESSION_TITLE_FLAG_ID)) return true;
  return config.get<SessionTitleConfig | undefined>(SESSION_TITLE_SECTION)?.enabled === true;
}

export function resolveSessionTitleModelAlias(config: IConfigService): string | undefined {
  const model = config.get<SessionTitleConfig | undefined>(SESSION_TITLE_SECTION)?.model;
  const trimmed = model?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function resolveSessionTitleRequester(
  config: IConfigService,
  catalog: IModelCatalog,
): ModelRequester | undefined {
  const alias = resolveSessionTitleModelAlias(config);
  if (alias === undefined) return undefined;
  const requester = tryGetRequester(catalog, alias);
  if (requester !== undefined) return requester;
  const ids = catalog.findByName(alias);
  if (ids.length === 0) return undefined;
  return tryGetRequester(catalog, ids[0]!);
}

function tryGetRequester(catalog: IModelCatalog, id: string): ModelRequester | undefined {
  try {
    return catalog.getRequester(id);
  } catch {
    return undefined;
  }
}
