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

/**
 * LOCAL-ONLY PATCH — never upstream. The tunables `kimi upgrade` exposes as
 * flags. Each one is forwarded to the pipeline script as the environment
 * variable it already reads, so the script needs no argument parsing and a
 * knob stays reachable by running the script directly. `version` is the only
 * one the script receives as its positional argument.
 */
export interface LocalUpgradeOptions {
  readonly version?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly local?: boolean;
  readonly strictUpstreamMerge?: boolean;
  readonly skipTypecheck?: boolean;
}

/**
 * LOCAL-ONLY PATCH — never upstream. Appended to `kimi upgrade --help`, which
 * otherwise documents only the stock installer — useless on a binary that
 * never uses it. The flags, the environment variables behind them, and the
 * refresh command for the installed script all belong in the help the command
 * prints about itself.
 */
export function formatLocalUpgradeHelp(script: string): string {
  return `
This binary is built from an upstream release plus the local patch branches in
the patch registry, so 'kimi upgrade' rebuilds it instead of installing the
stock release. The rebuild is delegated to:

  ${script}

It is idempotent — nothing happens while the release and the patch fingerprint
both match. Exit codes: 0 ok, 1 failed, 10 pre-flight merge gate (only with
--strict-upstream-merge), 11 applying the patches. The rebuild never prompts,
so upstream's -y/--yes has no effect once the pipeline is installed.

Every flag is forwarded to that script as an environment variable, so running
the script directly accepts the same knobs:

  DRY_RUN=1                        print the plan without building
  FORCE=1                          rebuild even when nothing changed
  KIMI_PATCH_LOCAL=1               build from the local patch branches, not origin
  STRICT_UPSTREAM_MERGE=1          make merge conflicts vs upstream/main fatal
  SKIP_TYPECHECK=1                 skip the pre-build type-check gate
  KIMI_PATCH_REPO=<path>           repo working tree
  KIMI_PATCH_STATE=<path>          patch registry and build state
  KIMI_UPGRADE_STRICT_SELFCHECK=1  make hook/registry drift fatal

Passing --help to the script prints the same list together with the registry
statuses; scripts/patched-upgrade/README.md documents the pipeline itself.
Refresh the installed script and registry after changing them, from the repo
root:

  git checkout origin/local/upgrade-hook -- scripts/patched-upgrade
  FORCE=1 bash scripts/patched-upgrade/install.sh
`;
}
