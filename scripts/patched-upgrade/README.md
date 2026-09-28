# Patched upgrade pipeline

Local-only tooling (never upstream) for running a kimi binary built from an
upstream release plus local patch branches. This directory holds the code and
is versioned on the `local/upgrade-hook` branch (pushed to the fork); the
live copies used at runtime are in `~/.kimi-code/`.

- `upgrade-with-patches.sh` — the pipeline. All update paths in the patched
  CLI delegate to `~/.kimi-code/upgrade-with-patches.sh` when it exists:
  `kimi upgrade`, the startup update prompt, and the automatic background
  install all run the script instead of the stock installer (the startup
  prompt shows the script as the install command). Patch branches are sourced
  from `origin` (fetched once up front; `KIMI_PATCH_LOCAL=1` switches to the
  local branches for development) — a branch that changed on the remote was
  rebased onto the current upstream main there, so the remote copy is
  authoritative — and strictly-behind local branches are fast-forwarded to it,
  so the branches an agent inspects afterwards match the ones the build used.
  The script fast-forwards
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
  the first conflict. A startup self-check also compares the live hook script,
  companion skill, and patch registry against their versioned source on
  `local/upgrade-hook` (blob comparison via `git hash-object` / `git show`, so
  it does not depend on the branch currently checked out): drift warns by
  default, and `KIMI_UPGRADE_STRICT_SELFCHECK=1` makes a hook-script or
  registry drift fatal (the skill mismatch only ever warns — it does not
  affect the build). The registry comparison covers the patch branch set and
  each branch's `pr`; `status` and the per-machine `state` are legitimate live
  data and are excluded. Refresh the script or skill with
  `FORCE=1 bash install.sh`, the registry with a plain `bash install.sh`.
- `install.sh` — installs the script, the companion skill, and the bundled
  patch registry into `~/.kimi-code/`. The script and skill keep an existing
  copy unless `FORCE=1`; the registry is always reinstalled, backing up the
  existing copy first — that copy is how a registry change reaches the live
  setup. It also records this checkout's path in `state.repoPath`.
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

The registry is versioned at `scripts/patched-upgrade/local-patches.json` on
`local/upgrade-hook`, and that bundled copy is canonical for this patch set:
a new machine picks the patch list up from it, and every `install.sh` run
copies it over `~/.kimi-code/local-patches.json` (backing up the existing
copy first). The pipeline reads the live copy at runtime, so changing the
patch set means editing the versioned file and re-running `install.sh`.
A live copy whose branch set or per-branch `pr` differs from the bundled one
is reported by the self-check described above. Format:

```json
{
  "patches": [
    { "branch": "fix/some-thing", "pr": 1234, "status": "active" },
    { "branch": "local/upgrade-hook", "pr": null, "status": "active", "localOnly": true }
  ]
}
```

- `branch`: the branch name. It is read from `origin/<branch>` whenever the
  remote has it — the remote copy is authoritative, because a branch that
  changed there is what a rebase-and-amend on the other machine produced — and
  from the local branch only for a patch that never left this machine.
  `KIMI_PATCH_LOCAL=1` inverts that order for development. The pipeline also
  fast-forwards a local branch that is strictly behind origin, so the branches
  you or an agent inspect match the ones the build used.
- `pr`: upstream PR number, used for merged-PR detection (the script marks
  the entry `"merged"` and stops applying it once the PR merges). `null`
  skips the check.
- `status`: `active` entries are applied; anything else is skipped.
- `localOnly`: informational — the branch is never pushed anywhere except
  the fork.

Per-machine `state` exists only in the live copy: `install.sh` re-records
`state.repoPath` after copying, and the pipeline writes the base release,
binary hash, patch fingerprint, and build time. The self-check excludes
`state` as per-machine data, which is why the versioned registry never carries
machine-specific paths. Since the copy replaces the file as a whole, the
recorded build state does not survive an `install.sh` run — the next pipeline
run rebuilds.

## Setup on a new machine

```sh
cd ~/workspace/kimi-code
git fetch origin
git checkout local/upgrade-hook        # or: git show origin/local/upgrade-hook:scripts/patched-upgrade/...
$EDITOR scripts/patched-upgrade/local-patches.json  # list your patch branches
scripts/patched-upgrade/install.sh     # installs script, skill, and registry into ~/.kimi-code
kimi upgrade                           # rebuilds the patched binary
```

## Notes

- `KIMI_LOCAL_UPGRADE_SCRIPT` overrides the script path the CLI hook uses;
  `KIMI_PATCH_REPO` / `KIMI_PATCH_STATE` override the script's defaults;
  `KIMI_PATCH_LOCAL=1` sources patch branches from the local branches instead
  of `origin` and skips the origin fetch (the development loop);
  `DRY_RUN=1` prints the plan without building; `FORCE=1` rebuilds anyway;
  `SKIP_TYPECHECK=1` bypasses the pre-build type-check gate.
- The script fails fast when `node --version` does not match `.nvmrc` — the
  SEA build needs the repo-pinned Node, not an arbitrary system Node.
