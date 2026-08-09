import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * LOCAL-ONLY PATCH — never upstream. Binaries built from a patched source
 * tree must never install the stock release: it would silently drop the
 * local patches. When the external patch pipeline script exists, every
 * install path (`kimi upgrade`, the startup prompt, the background
 * auto-install) delegates to it instead of spawning the stock installer —
 * the script checks the upstream release, the local patch registry, and the
 * installed binary, then rebuilds and swaps only when necessary.
 * `KIMI_LOCAL_UPGRADE_SCRIPT` overrides the script path. Returns null when
 * no pipeline is installed, in which case callers keep the stock behavior.
 */
export function resolveLocalUpgradePipeline(env: NodeJS.ProcessEnv = process.env): string | null {
  const script = env['KIMI_LOCAL_UPGRADE_SCRIPT'] ?? join(homedir(), '.kimi-code', 'upgrade-with-patches.sh');
  return existsSync(script) ? script : null;
}
