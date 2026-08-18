---
name: resolve-upgrade-conflicts
description: Use when the kimi patched upgrade pipeline (~/.kimi-code/upgrade-with-patches.sh) fails its merge-conflict gate or during cherry-pick, or before running an upgrade to pre-scan every active patch branch for conflicts vs upstream/main. Covers diagnosis, the rebase-and-adapt workflow (including when to resolve silently vs report to the user vs stop and ask), and the verification gates that must pass before re-running the pipeline.
---

# Resolve Patched-Upgrade Conflicts

The local kimi binary is built from an upstream release plus local patch branches (pipeline: `~/.kimi-code/upgrade-with-patches.sh`; repo source: `scripts/patched-upgrade/` on the `local/upgrade-hook` branch). The pipeline's merge gate is a pure simulation (`git merge-tree --write-tree` — branches are never modified): every active patch branch must merge cleanly into `upstream/main`, else the build stops and the installed binary stays untouched. A patch that can no longer land upstream must be rebased and verified before the pipeline can run again.

## 1. When this skill applies

The pipeline exits with:

- `ERROR: self-check: ... differs from the versioned source ...` — the live
  hook script or its companion skill drifted from the source of truth on
  `local/upgrade-hook`. Fix with `FORCE=1 bash <repo>/scripts/patched-upgrade/install.sh`
  (warn-only by default; the script variant is fatal under
  `KIMI_UPGRADE_STRICT_SELFCHECK=1`, the skill never blocks).
- `ERROR: patch <branch> has merge conflicts vs upstream/main: <paths>` — gate failed. The message reports **every** offending branch, one block per branch.
- `conflict applying <branch> onto <tag>` — a cherry-pick stopped mid-apply.

Both mean one or more patch branches need a rebase onto `upstream/main` (§3) plus the verification gates (§4). Also use this skill to pre-scan before an upgrade (§2) so the full fix list is known up front.

Inputs and conventions:

- Registry: `~/.kimi-code/local-patches.json` — `patches[]` (branch / pr / status) plus per-machine `state`. The pipeline owns this file; never hand-edit it.
- Env: `KIMI_PATCH_REPO` (repo path, default `~/workspace/kimi-code`), `KIMI_PATCH_STATE`, `DRY_RUN=1` (stop before build), `FORCE=1` (rebuild even when state matches), `SKIP_TYPECHECK=1`, `KIMI_UPGRADE_STRICT_SELFCHECK=1` (make live-script drift fatal; the skill mismatch still only warns).
- Merged-PR handling is automatic: an entry whose upstream `pr` is MERGED gets marked `merged` and skipped by the pipeline — do not rebase it.

## 2. Diagnose — enumerate every conflicting branch

The script itself collects all conflicts in one run. If you are pre-scanning, or the failure was a missing branch (`not found locally or on origin` — that is a registry/config error, stop and fix it), run the scan manually:

```bash
cd "$REPO" && git fetch upstream main
jq -r '.patches[] | select(.status=="active") | .branch' ~/.kimi-code/local-patches.json \
  | while read -r b; do
      ref=$(git show-ref --verify --quiet "refs/heads/$b" && echo "$b" || echo "origin/$b")
      printf '%s: ' "$b"
      git merge-tree --write-tree --name-only upstream/main "$ref" >/tmp/mt.out 2>&1 \
        && echo clean \
        || { echo CONFLICT; sed -n '2,/^[[:space:]]*$/p' /tmp/mt.out | sed '/^[[:space:]]*$/d'; }
    done
```

Interpretation:

- `clean` → nothing to do.
- Conflicts listing **only** `docs/state-manifest.d.ts` → noise (compiler-internal symbol ids drift on every regeneration); the pipeline tolerates and auto-resolves those — ignore.
- Branch already reachable from `upstream/main` (`git merge-base --is-ancestor <ref> upstream/main`) → already upstream; the apply phase reports it as "already upstream" — skip.
- Anything else → rebase it (§3).

## 3. Rebase & resolve — the triage table

For each conflicting branch:

```bash
git checkout <branch>
GIT_EDITOR=true git rebase upstream/main   # GIT_EDITOR=true: never let the commit editor hang the rebase
```

Governing principle: **the patch's intent outranks its literal diff.** When upstream refactored the code a patch touches, take upstream's new structure and re-apply the patch's behavior on top of it — do not fight the 3-way merge to preserve the old shape. Grep upstream first (`git grep <symbol> upstream/main -- <dir>`) to find where the relevant logic lives now and whether upstream already adopted the same fix in another form.

| Category | Includes | What to do |
|---|---|---|
| **Quiet-fix** (zero judgment, one correct answer) | Pure import conflicts (keep both sides' imports); doc / numbered-list conflicts (keep both, renumber); upstream already adopted the fix in a different shape (add only the missing delta) | Resolve, verify. No report beyond the normal completion summary. |
| **Report-but-continue** (a choice was made) | Semantic re-homing: module moved/renamed upstream, the patch delta must land in a new place and the landing spot is a choice; changes to user/model-visible text (placeholder wording, error messages, event/wire payloads); having to add code to files the patch never touched | Resolve, then flag the decision in the final report: what you chose, why, and the alternative you rejected. |
| **STOP and ask** (user decision required) | (1) More than one defensible resolution exists; (2) the patch may be redundant — upstream implemented equivalent behavior (decide: keep-and-adapt vs drop the branch); (3) the conflict is in a security-sensitive zone — spawn / PATH resolution that runs before the workspace-trust gate, permissions, auth (e.g. `apps/kimi-code/src/cli/update/preflight.ts`) | Do not resolve. Summarize the options and get the user's call. |

When unsure which row applies, treat it as report-but-continue. A wrong quiet adaptation gets baked into the binary; an extra report costs nothing.

Real examples from this repo's patches: AGENTS.md numbered-list conflicts → quiet; the media-domain projector split (`gateImageFormatParts` moved, projection-time self-heal) → report-but-continue; the `resolveInstallSpawn` refactor in `preflight.ts` → security-sensitive, stop and ask.

After resolving all hunks, check files that auto-merged but still need the delta too — upstream may have split/moved modules, so a patch that touched `contextProjectorService.ts` may need its behavior re-applied in the new `projection.ts` / `mediaProjection.ts` as well. Stage everything, then `GIT_EDITOR=true git rebase --continue`. Keep the branch's history coherent: fold test fixes into the commit that introduced them (`git commit --fixup <sha>` + `GIT_SEQUENCE_EDITOR=: GIT_EDITOR=true git rebase -i --autosquash <base>`), never leave them floating in an unrelated commit.

## 4. Verify before re-running the pipeline

Every rebased branch must pass all of these, or the pipeline will (correctly) refuse to build:

1. **Merge-tree green** per branch: `git merge-tree --write-tree --name-only upstream/main <branch>` exits 0, or lists only `docs/state-manifest.d.ts`.
2. **Type check** every package the branch touches, the same way the pipeline does:
   ```bash
   pnpm install   # stale symlinks (e.g. missing node_modules/immer) produce false TS2307 noise
   git diff --name-only upstream/main HEAD \
     | sed -n 's@^\(packages/[^/]*\|apps/[^/]*\)/.*@\1@p' | sort -u \
     | while read -r p; do (cd "$p" && pnpm exec tsc -p tsconfig.json --noEmit) || exit 1; done
   ```
3. **Tests**: if the adaptation changed behavior, run the patch branch's relevant tests — they encode the behavior contract (`pnpm --filter <pkg> test <file>`).

## 5. Re-run & confirm

Re-run `~/.kimi-code/upgrade-with-patches.sh`. On success it prints `done: kimi <version> + N patch(es) installed`. Confirm:

- `~/.kimi-code/bin/kimi --version` matches the target release;
- `~/.kimi-code/local-patches.json` → `state.baseRelease` / `state.builtHash` / `state.builtAt` updated;
- `~/.kimi-code/bin/kimi.prev.bak` exists (previous binary);
- the repo is back on its previous branch (the pipeline restores it) and the working tree is clean.

Note: rebasing a branch changes its head, which changes the patch fingerprint — the next upgrade rebuilds even for the same release. That is by design, not a failure.

## 6. Red lines

- Never push to `origin` without asking. Rebasing rewrites local history; pushes (including `local/upgrade-hook`, which carries the hook script and this skill's sibling tooling) happen only on explicit user request.
- Never hand-edit `~/.kimi-code/local-patches.json` — the pipeline owns the registry, including merged-PR `status` mutations.
- Never call a branch clean without `git merge-tree` actually green.
- Never resolve a STOP-and-ask conflict without the user's call.
- When adaptation changed behavior, the patch's own tests must still pass — silent behavior drift is how patches rot.