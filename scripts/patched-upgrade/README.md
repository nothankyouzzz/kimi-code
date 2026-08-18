# Patched upgrade pipeline

Local-only tooling (never upstream) for running a kimi binary built from an
upstream release plus local patch branches. This directory holds the code and
is versioned on the `local/upgrade-hook` branch (pushed to the fork); the
live copies used at runtime are in `~/.kimi-code/`.

- `upgrade-with-patches.sh` — the pipeline. All update paths in the patched
  CLI delegate to `~/.kimi-code/upgrade-with-patches.sh` when it exists:
  `kimi upgrade`, the startup update prompt, and the automatic background
  install all run the script instead of the stock installer (the startup
  prompt shows the script as the install command). The script fast-forwards
  the local `main` to `upstream/main`,
  gates on a merge-conflict check (every active patch branch must merge
  cleanly into `upstream/main`, simulated with `git merge-tree` — the
  branches are never modified), cherry-picks the patches onto the target
  release tag, type-checks the packages the patches touched (a patch
  referencing a module upstream renamed or moved fails here with the
  responsible patch named, instead of as a bare build error), rebuilds, and
  atomically swaps `~/.kimi-code/bin/kimi`.
  Idempotent: no rebuild when the release AND the patch fingerprint are
  unchanged. Conflict policy: conflicts confined to generated docs manifests
  (`docs/state-manifest.d.ts`, whose embedded compiler symbol ids drift on
  every regeneration) are tolerated in the check and auto-resolved during
  cherry-pick by taking the patch side; any other conflict fails fast and
  leaves the installed binary untouched. The gate reports every offending
  branch at once — a single run names the full fix list rather than dying on
  the first conflict. A startup self-check also compares the live hook script
  and companion skill against their versioned source on `local/upgrade-hook`
  (`git hash-object` vs the branch blobs): drift warns by default, and
  `KIMI_UPGRADE_STRICT_SELFCHECK=1` makes a live-script drift fatal (the
  skill mismatch only ever warns — it does not affect the build). Refresh
  either with `FORCE=1 bash install.sh`.
- `install.sh` — installs the script and the companion skill into
  `~/.kimi-code/` (keeps an existing copy unless `FORCE=1`) and seeds an
  empty patch registry if none exists.
- `test/smoke.sh` — standalone smoke tests running the pipeline under
  `DRY_RUN=1` against temporary state files and fixture branches to assert
  the clean path, the multi-conflict gate, and self-check drift tiers.
- `skills/resolve-upgrade-conflicts/SKILL.md` — the companion skill
  (`resolve-upgrade-conflicts`, user scope at `<KIMI_CODE_HOME>/skills/`):
  an agent-side playbook for resolving the conflicts the pipeline reports —
  diagnosis (enumerate every conflicting branch), the rebase-and-adapt
  workflow with a triage table (resolve silently vs report vs stop and ask),
  and the merge-tree + type-check verification gates that must pass before
  re-running the pipeline.

## The patch registry

`~/.kimi-code/local-patches.json` is live-only config and is deliberately NOT
versioned in the repo: its contents describe branches (already git refs,
recoverable from the fork's branch list and `gh pr list`), and committing
registry bookkeeping to `local/upgrade-hook` would change that branch's head
and force a pointless binary rebuild. Format:

```json
{
  "patches": [
    { "branch": "fix/some-thing", "pr": 1234, "status": "active" },
    { "branch": "local/upgrade-hook", "pr": null, "status": "active", "localOnly": true }
  ]
}
```

- `branch`: a local branch (preferred) or one fetched from origin.
- `pr`: upstream PR number, used for merged-PR detection (the script marks
  the entry `"merged"` and stops applying it once the PR merges). `null`
  skips the check.
- `status`: `active` entries are applied; anything else is skipped.
- `localOnly`: informational — the branch is never pushed anywhere except
  the fork.

The script additionally writes per-machine `state` (base release, binary
hash, build time) into this file, which is another reason it stays out of
git.

## Setup on a new machine

```sh
cd ~/workspace/kimi-code
git fetch origin
git checkout local/upgrade-hook        # or: git show origin/local/upgrade-hook:scripts/patched-upgrade/...
scripts/patched-upgrade/install.sh
$EDITOR ~/.kimi-code/local-patches.json  # list your patch branches
kimi upgrade                           # rebuilds the patched binary
```

## Notes

- `KIMI_LOCAL_UPGRADE_SCRIPT` overrides the script path the CLI hook uses;
  `KIMI_PATCH_REPO` / `KIMI_PATCH_STATE` override the script's defaults;
  `DRY_RUN=1` prints the plan without building; `FORCE=1` rebuilds anyway;
  `SKIP_TYPECHECK=1` bypasses the pre-build type-check gate.
- The script fails fast when `node --version` does not match `.nvmrc` — the
  SEA build needs the repo-pinned Node, not an arbitrary system Node.
