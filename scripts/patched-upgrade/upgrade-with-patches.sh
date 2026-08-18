#!/usr/bin/env bash
# upgrade-with-patches.sh — rebuild kimi from an upstream release with local
# patch branches applied, then atomically swap it into ~/.kimi-code/bin/kimi.
#
# This file is the source of truth, managed in the repo (local/upgrade-hook
# branch, pushed to the fork). The live copy used by the upgrade hook is
# ~/.kimi-code/upgrade-with-patches.sh — install/update it with install.sh.
#
# Invoked by the local `kimi upgrade` delegation hook (target version as $1),
# or run directly. Before building, the pipeline syncs the local main branch
# to upstream/main (fast-forward only) and gates on a merge-conflict check:
# every active patch branch must merge cleanly into upstream/main (simulated
# with git merge-tree — the branches themselves are never modified), so a
# patch that can no longer land upstream stops the build instead of being
# baked into the binary. The check collects every non-tolerated conflict and
# reports all offending branches in one run, so a broken upgrade names the
# full fix list instead of dying on the first hit. A self-check at startup
# compares the live hook script and companion skill against their versioned
# source on local/upgrade-hook (warn by default; KIMI_UPGRADE_STRICT_SELFCHECK=1
# makes a live-script drift fatal — the skill only ever warns). Idempotent:
# exits without rebuilding when the recorded state already matches the target
# release AND the patch fingerprint (active branches + their head commits) — a
# new or updated patch forces a rebuild even when the release is unchanged.
#
# Conflict policy: conflicts confined to generated docs manifests
# (docs/state-manifest.d.ts — it embeds compiler-internal unique-symbol ids
# that drift on every regeneration) are tolerated in the merge check and
# auto-resolved during cherry-pick by taking the patch side. ANY other
# conflict — in the merge check or during cherry-pick — fails fast, stops
# the build, and leaves the installed binary untouched.
#
# The merge check is text-only; before the heavy build the script type-checks
# every package the patches touched (tsc --noEmit per package tsconfig), so a
# patch referencing a module upstream renamed or moved fails here with the
# responsible patch named, instead of as an opaque rolldown error. SKIP_TYPECHECK=1
# bypasses the gate.
#
# Env overrides:
#   KIMI_PATCH_REPO   repo working tree (default ~/workspace/kimi-code)
#   KIMI_PATCH_STATE  registry/state file (default ~/.kimi-code/local-patches.json)
#   DRY_RUN=1         stop before the build step, print the plan only
#   FORCE=1           rebuild even when state matches the target release
#   SKIP_TYPECHECK=1  skip the pre-build type-check gate
set -euo pipefail

REPO="${KIMI_PATCH_REPO:-$HOME/workspace/kimi-code}"
STATE_FILE="${KIMI_PATCH_STATE:-$HOME/.kimi-code/local-patches.json}"
BIN_DIR="$HOME/.kimi-code/bin"
UPSTREAM_REPO="MoonshotAI/kimi-code"
TAG_PREFIX="@moonshot-ai/kimi-code@"

log() { printf '[kimi-patched-upgrade] %s\n' "$*"; }
die() { printf '[kimi-patched-upgrade] ERROR: %s\n' "$*" >&2; exit 1; }

# When a cherry-pick stops on conflicts that are ALL in generated docs
# manifests (state-manifest.d.ts), resolve them by taking the patch side
# ("theirs" is the commit being replayed) and return 0. The file carries
# compiler-internal unique-symbol ids that drift on every regeneration, so
# the conflict is always noise; it is docs-only and never reaches the built
# binary. Any other conflicted file → return 1.
try_manifest_autoresolve() {
  local unmerged
  unmerged=$(git diff --name-only --diff-filter=U)
  [ -n "$unmerged" ] || return 1
  if printf '%s\n' "$unmerged" | grep -qv 'docs/state-manifest\.d\.ts$'; then
    return 1
  fi
  log "auto-resolving generated-manifest conflict in: $unmerged"
  printf '%s\n' "$unmerged" | xargs git checkout --theirs --
  printf '%s\n' "$unmerged" | xargs git add --
}

[ -d "$REPO/.git" ] || die "repo not found at $REPO (set KIMI_PATCH_REPO)"
[ -f "$STATE_FILE" ] || die "registry not found at $STATE_FILE"
command -v gh >/dev/null || die "gh CLI is required"
command -v jq >/dev/null || die "jq is required"
command -v git >/dev/null || die "git is required"
command -v pnpm >/dev/null || die "pnpm is required"
command -v node >/dev/null || die "node is required"

# The SEA build needs the repo-pinned Node; a build without SEA support (e.g.
# the linuxbrew one) only fails late with an opaque "Single executable
# application is disabled". Compare against .nvmrc up front instead.
if [ -f "$REPO/.nvmrc" ]; then
  WANT_NODE=$(tr -d 'v[:space:]' < "$REPO/.nvmrc")
  HAVE_NODE=$(node --version | tr -d 'v[:space:]')
  if [ "$HAVE_NODE" != "$WANT_NODE" ]; then
    die "node $WANT_NODE required (per $REPO/.nvmrc) but 'node' is $HAVE_NODE ($(command -v node)) — fix PATH (e.g. open a fresh shell so nvm loads) and rerun"
  fi
fi

cd "$REPO"
# Only tracked changes block the run: untracked files (editor swap files,
# Syncthing .tmp artifacts, build leftovers) affect neither the cherry-picks
# nor the build.
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "repo working tree has uncommitted changes; commit or stash first"

GIT_DIR=$(git rev-parse --git-dir)
PREV_REF=$(git symbolic-ref --short -q HEAD || git rev-parse HEAD)
restore_ref() { git checkout --quiet "$PREV_REF" 2>/dev/null || true; }
trap restore_ref EXIT

# --- 0. self-check: live copies vs their versioned source ----------------------
# The live hook script and companion skill must match the versions committed on
# the local/upgrade-hook branch (git hash-object vs the blobs on the branch, so
# the comparison is exact regardless of the branch currently checked out).
# Default: warn and continue — the drift is surfaced, the upgrade proceeds.
# KIMI_UPGRADE_STRICT_SELFCHECK=1 turns a live-SCRIPT drift into a hard stop
# (the script is what is about to run); the SKILL never blocks — it does not
# affect the build. A versioned source missing from the branch is a config
# error, not a drift: die. The live patch registry (local-patches.json) is
# deliberately live-only and is not checked.
SELF_HOOK_BLOB_REF=$(git show-ref --verify --quiet refs/heads/local/upgrade-hook && echo refs/heads/local/upgrade-hook \
  || { git fetch origin local/upgrade-hook --quiet 2>/dev/null; \
       git show-ref --verify --quiet refs/remotes/origin/local/upgrade-hook \
         && echo refs/remotes/origin/local/upgrade-hook || echo missing; })
if [ "$SELF_HOOK_BLOB_REF" = "missing" ]; then
  log "self-check skipped: local/upgrade-hook ref not found locally or on origin"
else
  selfcheck_live_vs_repo() {
    local label="$1" live_path="$2" repo_path="$3" block="$4"
    local live_sha repo_sha
    if [ -f "$live_path" ]; then
      live_sha=$(git hash-object "$live_path")
    else
      live_sha="<absent>"
    fi
    repo_sha=$(git rev-parse "$SELF_HOOK_BLOB_REF:$repo_path" 2>/dev/null) || {
      die "self-check: $repo_path does not exist on $SELF_HOOK_BLOB_REF — fix the branch, then rerun"
    }
    if [ "$live_sha" != "$repo_sha" ]; then
      local sync_hint="FORCE=1 bash $REPO/scripts/patched-upgrade/install.sh"
      if [ "$block" = "strict" ] && [ "${KIMI_UPGRADE_STRICT_SELFCHECK:-0}" = "1" ]; then
        die "self-check: $label ($live_path) differs from the versioned source ($SELF_HOOK_BLOB_REF:$repo_path). Refresh it with '$sync_hint', then rerun. Binary untouched."
      fi
      log "self-check: $label ($live_path) differs from the versioned source ($SELF_HOOK_BLOB_REF:$repo_path) — refresh it with '$sync_hint'"
    fi
  }
  selfcheck_live_vs_repo "hook script" "$HOME/.kimi-code/upgrade-with-patches.sh" \
    "scripts/patched-upgrade/upgrade-with-patches.sh" strict
  selfcheck_live_vs_repo "companion skill" "$HOME/.kimi-code/skills/resolve-upgrade-conflicts/SKILL.md" \
    "scripts/patched-upgrade/skills/resolve-upgrade-conflicts/SKILL.md" warn
fi

# --- 1. resolve target version ---------------------------------------------
TARGET_VERSION="${1:-}"
if [ -z "$TARGET_VERSION" ]; then
  TARGET_VERSION=$(HTTPS_PROXY= HTTP_PROXY= https_proxy= http_proxy= \
    gh release view -R "$UPSTREAM_REPO" --json tagName -q '.tagName' | sed "s|^${TAG_PREFIX}||")
fi
[[ "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bad target version: '$TARGET_VERSION'"
TAG="${TAG_PREFIX}${TARGET_VERSION}"

# --- 2. sync main and check patch branches for conflicts vs upstream/main ---
git fetch upstream main --quiet

# The local main mirrors upstream main; fast-forward only. A diverged main
# means someone committed directly to it — stop and let a human reconcile.
git merge-base --is-ancestor main upstream/main \
  || die "local main has diverged from upstream/main — reconcile manually, then rerun"
if [ "$(git rev-parse main)" != "$(git rev-parse upstream/main)" ]; then
  if [ "$(git symbolic-ref --short -q HEAD)" = "main" ]; then
    git merge --ff-only upstream/main --quiet
  else
    git branch -f main upstream/main
  fi
  log "main synced to upstream/main ($(git rev-parse --short upstream/main))"
fi

# Gate: every active patch branch must merge cleanly into upstream/main —
# this is exactly what the open PR's mergeability check will see. The check
# is a pure merge simulation (git merge-tree --write-tree): the branches and
# the working tree are never touched. Conflicts confined to generated docs
# manifests are tolerated (see try_manifest_autoresolve). Every non-tolerated
# conflict is collected and reported at once — dying on the first hit would
# force a fix-rebase-rerun cycle per branch, when a single run can name all
# of them.
PATCH_COUNT=$(jq '.patches | length' "$STATE_FILE")
CHECKED=()
CONFLICT_BLOCKS=()
for i in $(seq 0 $((PATCH_COUNT - 1))); do
  BRANCH=$(jq -r ".patches[$i].branch" "$STATE_FILE")
  PR=$(jq -r ".patches[$i].pr" "$STATE_FILE")
  STATUS=$(jq -r ".patches[$i].status" "$STATE_FILE")
  [ "$STATUS" = "active" ] || continue

  # Merged-PR detection up front: upstream already carries the change.
  if [ "$PR" != "null" ]; then
    PR_STATE=$(HTTPS_PROXY= HTTP_PROXY= https_proxy= http_proxy= \
      gh pr view "$PR" -R "$UPSTREAM_REPO" --json state -q '.state' 2>/dev/null || echo "UNKNOWN")
    if [ "$PR_STATE" = "MERGED" ]; then
      log "patch $BRANCH: PR #$PR is merged — marking merged, skipping"
      TMP=$(mktemp)
      jq ".patches[$i].status = \"merged\"" "$STATE_FILE" > "$TMP" && mv "$TMP" "$STATE_FILE"
      continue
    fi
  fi

  # Prefer the local branch (local-only patches never leave the machine);
  # otherwise fetch the branch from origin.
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    REF="$BRANCH"
  else
    git fetch origin "$BRANCH" --quiet
    git show-ref --verify --quiet "refs/remotes/origin/$BRANCH" \
      || die "patch branch $BRANCH not found locally or on origin"
    REF="origin/$BRANCH"
  fi
  # Already merged into upstream/main — trivially conflict-free; the apply
  # phase below will report it as "already upstream".
  git merge-base --is-ancestor "$REF" upstream/main && continue

  MERGE_TREE_OUT=$(git merge-tree --write-tree --name-only upstream/main "$REF") || {
    # Exit 1 = merge conflicts. The output is: tree oid, conflicted paths
    # (one per line, --name-only), blank line, conflict messages.
    CONFLICTED=$(printf '%s\n' "$MERGE_TREE_OUT" | sed -n '2,/^[[:space:]]*$/p' | sed '/^[[:space:]]*$/d')
    if [ -n "$CONFLICTED" ] && ! printf '%s\n' "$CONFLICTED" | grep -qv 'docs/state-manifest\.d\.ts$'; then
      log "patch $BRANCH: only generated-manifest conflicts vs upstream/main — tolerated"
    else
      CONFLICT_BLOCKS+=("patch $BRANCH has merge conflicts vs upstream/main:
$CONFLICTED")
    fi
  }
  CHECKED+=("$BRANCH")
done
if [ ${#CONFLICT_BLOCKS[@]} -ne 0 ]; then
  die "$(printf '%s\n' "${CONFLICT_BLOCKS[@]}")

Resolve each branch (merge or rebase it onto upstream/main yourself), then rerun. Binary untouched."
fi

# Fingerprint of the effective patch inputs: the target release plus, for each
# active patch, the branch name and its head commit (extras pulled in by git
# cherry are ancestors of the branch head, so the head sha pins them too). A
# new/changed patch with an unchanged release is still a different build, so
# the idempotency check must compare this.
FINGERPRINT_INPUT="$TARGET_VERSION"
for i in $(seq 0 $((PATCH_COUNT - 1))); do
  F_BRANCH=$(jq -r ".patches[$i].branch" "$STATE_FILE")
  F_STATUS=$(jq -r ".patches[$i].status" "$STATE_FILE")
  [ "$F_STATUS" = "active" ] || continue
  F_SHA=$(git rev-parse --verify --quiet "refs/heads/$F_BRANCH" \
    || git rev-parse --verify --quiet "refs/remotes/origin/$F_BRANCH" \
    || echo "missing")
  FINGERPRINT_INPUT+=$'\n'"$F_BRANCH@$F_SHA"
done
PATCHES_HASH=$(printf '%s' "$FINGERPRINT_INPUT" | sha256sum | awk '{print $1}')

CURRENT_BASE=$(jq -r '.state.baseRelease // empty' "$STATE_FILE")
CURRENT_PATCHES_HASH=$(jq -r '.state.patchesHash // empty' "$STATE_FILE")
if [ "$CURRENT_BASE" = "$TARGET_VERSION" ] && [ "$CURRENT_PATCHES_HASH" = "$PATCHES_HASH" ] && [ "${FORCE:-0}" != "1" ]; then
  log "already at $TARGET_VERSION with patches applied — nothing to do"
  exit 0
fi
log "target release: $TARGET_VERSION (current base: ${CURRENT_BASE:-none})"

# --- 3. fetch the release tag and check out a build branch ------------------
if ! git rev-parse --verify "refs/tags/${TAG}^{commit}" >/dev/null 2>&1; then
  log "fetching tag $TAG"
  git fetch upstream "refs/tags/${TAG}:refs/tags/${TAG}" --quiet
fi
RELEASE_COMMIT=$(git rev-parse "refs/tags/${TAG}^{}")
log "release commit: $RELEASE_COMMIT"

git checkout --quiet -B local/patched "$RELEASE_COMMIT"

# --- 4. apply patches --------------------------------------------------------
APPLIED=()
SKIPPED=()
# Upstream context commits (between the release tag and a patch branch's base)
# repeat across every patch branch with the SAME sha. Re-picking one is not
# harmless: the 3-way merge can leave a partial residual (not an empty pick),
# which then conflicts with later patches or re-applies add/delete pairs.
# Dedup them by sha across the whole run.
declare -A PICKED_SHAS=()
for i in $(seq 0 $((PATCH_COUNT - 1))); do
  BRANCH=$(jq -r ".patches[$i].branch" "$STATE_FILE")
  STATUS=$(jq -r ".patches[$i].status" "$STATE_FILE")
  [ "$STATUS" = "active" ] || { SKIPPED+=("$BRANCH ($STATUS)"); continue; }

  # Resolve the same ref the conflict check used: local branch preferred,
  # origin fallback.
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    REF="$BRANCH"
  else
    REF="origin/$BRANCH"
  fi
  # Every commit the branch carries that the release does not (patch-id
  # comparison, so upstream squash-merges are detected). This intentionally
  # includes upstream commits between the release tag and the branch's base:
  # the patch was written against that newer main and may not apply to the
  # bare release without them.
  mapfile -t CHERRY < <(git cherry "$RELEASE_COMMIT" "$REF")
  COMMITS=()
  for line in "${CHERRY[@]}"; do
    [ "${line:0:1}" = "+" ] && COMMITS+=("${line:2}")
  done
  if [ ${#COMMITS[@]} -eq 0 ]; then
    log "patch $BRANCH: equivalent changes already in $TAG — skipping"
    SKIPPED+=("$BRANCH (already upstream)")
    continue
  fi

  log "patch $BRANCH: cherry-picking ${#COMMITS[@]} commit(s)"
  for c in "${COMMITS[@]}"; do
    [ -n "${PICKED_SHAS[$c]:-}" ] && continue
    PICKED_SHAS[$c]=1
    git cherry-pick "$c" >/dev/null 2>&1 && continue
    # A commit an earlier patch branch already pulled in stops as an empty
    # pick — skip it. (Untracked files don't make the pick non-empty.)
    if [ -f "$GIT_DIR/CHERRY_PICK_HEAD" ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then
      git cherry-pick --skip >/dev/null 2>&1
      continue
    fi
    # Generated-manifest-only conflicts are noise — take the patch side.
    if try_manifest_autoresolve && GIT_EDITOR=true git cherry-pick --continue >/dev/null 2>&1; then
      continue
    fi
    # Anything else is a real conflict: abort and die.
    git cherry-pick --abort >/dev/null 2>&1 || true
    die "conflict applying $BRANCH onto $TAG — resolve manually, then rerun. Binary untouched."
  done
  APPLIED+=("$BRANCH (${#COMMITS[@]} commit(s))")
done

# --- 5. report / dry run ------------------------------------------------------
if [ ${#APPLIED[@]} -eq 0 ]; then
  log "patches applied: none"
else
  log "patches applied:"
  for p in "${APPLIED[@]}"; do log "  + $p"; done
fi
if [ ${#SKIPPED[@]} -eq 0 ]; then
  log "patches skipped: none"
else
  log "patches skipped:"
  for p in "${SKIPPED[@]}"; do log "  - $p"; done
fi
if [ ${#CHECKED[@]} -ne 0 ]; then
  log "merge-conflict check vs upstream/main passed for ${#CHECKED[@]} patch branch(es)"
fi
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN=1 — stopping before build"
  exit 0
fi

# --- 6. build -----------------------------------------------------------------
log "building (this takes a few minutes)"
pnpm install --quiet

# The merge-conflict gate (step 2) only detects textual conflicts; it is
# blind to semantic breakage such as upstream renaming a module that a
# patch still references (TS2307 / UNRESOLVED_IMPORT at build time). Type-
# check every package whose files the patches touched, so such a failure is
# caught here — named per package and attributed to the responsible patch
# branch — instead of surfacing as a bare rolldown error during the heavy
# build. Workspace packages export source `.ts` directly, so `tsc` needs no
# build step. SKIP_TYPECHECK=1 bypasses the gate.
if [ "${SKIP_TYPECHECK:-0}" != "1" ]; then
  log "type-checking packages touched by patches (SKIP_TYPECHECK=1 to bypass)"
  TSC_FAILED=0
  while IFS= read -r PKG; do
    [ -f "$PKG/tsconfig.json" ] || continue
    if ! TSC_OUT=$(cd "$PKG" && pnpm exec tsc -p tsconfig.json --noEmit 2>&1); then
      log "type check FAILED in $PKG:"
      printf '%s\n' "$TSC_OUT" | tail -25
      for i in $(seq 0 $((PATCH_COUNT - 1))); do
        T_BRANCH=$(jq -r ".patches[$i].branch" "$STATE_FILE")
        T_STATUS=$(jq -r ".patches[$i].status" "$STATE_FILE")
        [ "$T_STATUS" = "active" ] || continue
        T_SHA=$(git rev-parse --verify --quiet "refs/heads/$T_BRANCH" \
          || git rev-parse --verify --quiet "refs/remotes/origin/$T_BRANCH" \
          || echo "missing")
        if [ "$T_SHA" != "missing" ] && [ -n "$(git diff --name-only "$RELEASE_COMMIT" "$T_SHA" -- "$PKG")" ]; then
          log "  likely responsible patch: $T_BRANCH (touches $PKG)"
        fi
      done
      TSC_FAILED=1
    fi
  done < <(git diff --name-only "$RELEASE_COMMIT" HEAD \
    | sed -n 's@^\(packages/[^/]*\|apps/[^/]*\)/.*@\1@p' \
    | sort -u)
  if [ "$TSC_FAILED" = "1" ]; then
    die "type check failed in package(s) touched by patches — fix the responsible patch branch (likely a stale import after an upstream rename), then rerun. Binary untouched."
  fi
fi

pnpm --filter @moonshot-ai/kimi-code run build >/dev/null
pnpm --filter @moonshot-ai/kimi-code run build:native:sea >/dev/null
NEW_BIN="$REPO/apps/kimi-code/dist-native/bin/linux-x64/kimi"
[ -x "$NEW_BIN" ] || die "build finished but $NEW_BIN is missing"

NEW_VERSION=$("$NEW_BIN" --version)
[ "$NEW_VERSION" = "$TARGET_VERSION" ] || log "warning: built --version $NEW_VERSION != target $TARGET_VERSION"

# --- 7. swap the binary atomically --------------------------------------------
mkdir -p "$BIN_DIR"
if [ -f "$BIN_DIR/kimi" ]; then
  cp "$BIN_DIR/kimi" "$BIN_DIR/kimi.prev.bak"
fi
# Same-filesystem rename: atomic, needs no extra space, safe while a server runs.
mv -f "$NEW_BIN" "$BIN_DIR/kimi"
NEW_HASH=$(sha256sum "$BIN_DIR/kimi" | awk '{print $1}')

# --- 8. persist state ----------------------------------------------------------
TMP=$(mktemp)
jq --arg base "$TARGET_VERSION" --arg hash "$NEW_HASH" --arg phash "$PATCHES_HASH" --arg at "$(date -Is)" \
  '.state.baseRelease = $base | .state.builtHash = $hash | .state.patchesHash = $phash | .state.builtAt = $at' \
  "$STATE_FILE" > "$TMP" && mv "$TMP" "$STATE_FILE"

log "done: kimi $TARGET_VERSION + ${#APPLIED[@]} patch(es) installed (sha256 ${NEW_HASH:0:12}…)"
log "previous binary backed up at $BIN_DIR/kimi.prev.bak"
