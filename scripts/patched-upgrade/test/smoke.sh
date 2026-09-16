#!/usr/bin/env bash
# smoke.sh — smoke-test upgrade-with-patches.sh in isolation using DRY_RUN=1,
# temporary state files, and fixture branches. Exercises the self-check (script,
# skill, registry drift), the multi-conflict gate, and the clean DRY_RUN path
# without building or touching ~/.kimi-code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PIPELINE="$SCRIPT_DIR/../upgrade-with-patches.sh"
LIVE_STATE="$HOME/.kimi-code/local-patches.json"

[ -f "$PIPELINE" ] || { echo "FAIL: pipeline missing at $PIPELINE" >&2; exit 1; }
[ -f "$LIVE_STATE" ] || { echo "FAIL: live state missing at $LIVE_STATE" >&2; exit 1; }

PASS=0
FAIL=0
pass() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

TMP_DIR="$(mktemp -d /tmp/kimi-upgrade-smoke.XXXXXX)"
START_BRANCH="$(git -C "$REPO_DIR" branch --show-current)"
cleanup() {
  # A fixture commit can fail (a repository pre-commit hook rejecting the
  # deliberately bogus fixture file). The tree is then left dirty on the
  # fixture branch, a plain checkout refuses, and the repo is stranded there
  # with parts of the working tree missing — force the return in that case.
  if ! git -C "$REPO_DIR" checkout -q "$START_BRANCH" 2>/dev/null; then
    git -C "$REPO_DIR" checkout -qf "$START_BRANCH" 2>/dev/null || true
  fi
  git -C "$REPO_DIR" branch -D test/smoke-fake-1 test/smoke-fake-2 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "=== Patched-Upgrade Smoke Tests ==="

# 1. Clean DRY_RUN: the merge gate passes and the run stops at the DRY_RUN
# marker. The live registry legitimately contains branches that no longer merge
# (that is exactly what the companion skill's §3 fixes), so the fixture is built
# from the branches that are clean right now — this assertion is about the
# pipeline's clean path, not about today's patch health.
echo "1. clean DRY_RUN stops at the build gate"
CLEAN_BRANCHES=$(jq -r '.patches[] | select(.status=="active") | .branch' "$LIVE_STATE" | while read -r b; do
  if git -C "$REPO_DIR" show-ref --verify --quiet "refs/remotes/origin/$b"; then
    ref="origin/$b"
  else
    ref="$b"
  fi
  if git -C "$REPO_DIR" merge-tree --write-tree "upstream/main" "$ref" >/dev/null 2>&1; then
    printf '%s\n' "$b"
  fi
done | jq -R . | jq -s .)
TMP_CLEAN_REGISTRY="$TMP_DIR/clean.json"
jq --argjson branches "$CLEAN_BRANCHES" \
  '{patches: [.patches[] | select(.branch as $b | $branches | index($b))], state: .state}' \
  "$LIVE_STATE" > "$TMP_CLEAN_REGISTRY"
if OUT=$(KIMI_PATCH_REPO="$REPO_DIR" KIMI_PATCH_STATE="$TMP_CLEAN_REGISTRY" DRY_RUN=1 bash "$PIPELINE" 2>&1); then
  if printf '%s\n' "$OUT" | grep -q "DRY_RUN=1 — stopping before build"; then
    pass "clean DRY_RUN stops at the build gate ($(printf '%s' "$CLEAN_BRANCHES" | jq 'length') clean branch(es))"
  else
    fail "DRY_RUN finished without the expected stop message"
  fi
else
  fail "clean DRY_RUN exited nonzero: $OUT"
fi

# 2. Self-check: script drift under STRICT must die with Binary untouched
echo "2. self-check: script drift + strict"
TMP_SCRIPT="$TMP_DIR/upgrade.sh"
cp "$PIPELINE" "$TMP_SCRIPT"
echo "# drift" >> "$TMP_SCRIPT"
if OUT=$(HOME="$TMP_DIR" KIMI_PATCH_REPO="$REPO_DIR" KIMI_PATCH_STATE="$LIVE_STATE" \
    KIMI_UPGRADE_STRICT_SELFCHECK=1 DRY_RUN=1 bash "$TMP_SCRIPT" 2>&1); then
  fail "strict self-check succeeded on drifted script"
else
  if printf '%s\n' "$OUT" | grep -q "differs from the versioned source"; then
    pass "strict self-check dies with drift diagnostic"
  else
    fail "strict self-check died without expected drift message: $OUT"
  fi
fi

# 3. Self-check: registry missing branch warns by default, dies under strict.
# Isolated: a pristine HOME carries exact copies of the branch's hook+skill, so
# only the registry drifts — the live install may legitimately lag the branch
# head, which would otherwise trip the hook check first.
echo "3. self-check: registry drift"
TMP_REGISTRY="$TMP_DIR/patches.json"
jq 'del(.patches[] | select(.branch == "fix/wsl-clipboard-bmp"))' "$LIVE_STATE" > "$TMP_REGISTRY"
mkdir -p "$TMP_DIR/.kimi-code/skills/resolve-upgrade-conflicts"
# A pristine HOME must carry the *authoritative* copies: the pipeline resolves
# the versioned source from origin by default, so copying the working tree here
# would trip the hook-script check first and mask the registry drift this test
# is about.
SELF_SRC_REF=$(git -C "$REPO_DIR" show-ref --verify --quiet refs/remotes/origin/local/upgrade-hook \
  && echo origin/local/upgrade-hook || echo local/upgrade-hook)
git -C "$REPO_DIR" show "$SELF_SRC_REF:scripts/patched-upgrade/upgrade-with-patches.sh" > "$TMP_DIR/.kimi-code/upgrade-with-patches.sh"
chmod +x "$TMP_DIR/.kimi-code/upgrade-with-patches.sh"
git -C "$REPO_DIR" show "$SELF_SRC_REF:scripts/patched-upgrade/skills/resolve-upgrade-conflicts/SKILL.md" > "$TMP_DIR/.kimi-code/skills/resolve-upgrade-conflicts/SKILL.md"

OUT=$(HOME="$TMP_DIR" KIMI_PATCH_REPO="$REPO_DIR" KIMI_PATCH_STATE="$TMP_REGISTRY" DRY_RUN=1 bash "$PIPELINE" 2>&1 || true)
if printf '%s\n' "$OUT" | grep -q "only-in-repo: fix/wsl-clipboard-bmp"; then
  pass "registry drift warns under default mode"
else
  fail "registry drift did not warn: $OUT"
fi

if OUT=$(HOME="$TMP_DIR" KIMI_PATCH_REPO="$REPO_DIR" KIMI_PATCH_STATE="$TMP_REGISTRY" KIMI_UPGRADE_STRICT_SELFCHECK=1 DRY_RUN=1 \
    bash "$PIPELINE" 2>&1); then
  fail "strict self-check succeeded on drifted registry"
else
  if printf '%s\n' "$OUT" | grep -q "patch registry drift"; then
    pass "strict self-check dies on registry drift"
  else
    fail "strict self-check did not die with expected registry message: $OUT"
  fi
fi

# 4. Multi-conflict gate: reports all conflicting branches at once
echo "4. multi-conflict gate: reports all branches in one run"
git -C "$REPO_DIR" branch -D test/smoke-fake-1 test/smoke-fake-2 2>/dev/null || true
# Two fixture branches guaranteed to conflict with upstream/main whatever
# upstream changed: each is based on upstream/main~4 and clobbers a file that
# upstream modified between main~4 and main — a full-file rewrite overlaps any
# region upstream touched, so the 3-way merge conflicts by construction.
CONFLICT_FILES=($(git -C "$REPO_DIR" diff --name-only --diff-filter=M upstream/main~4 upstream/main | head -2))
[ "${#CONFLICT_FILES[@]}" -ge 2 ] || {
  echo "FAIL: cannot build conflicting fixtures (need >=2 upstream-modified files between main~4..main)" >&2
  exit 1
}
C1="${CONFLICT_FILES[0]}"
C2="${CONFLICT_FILES[1]}"
# The fixture commits must not run repository tooling: the pre-commit hook
# (lint-staged → oxlint) rejects the deliberately bogus fixture file, which
# would leave no fixture branch at all.
NO_HOOKS="$TMP_DIR/nohooks"
mkdir -p "$NO_HOOKS"
git -C "$REPO_DIR" checkout -q -b test/smoke-fake-1 upstream/main~4
printf 'smoke fixture rewrite 1 — force a merge conflict vs upstream/main\n' > "$REPO_DIR/$C1"
git -C "$REPO_DIR" -c core.hooksPath="$NO_HOOKS" -c commit.gpgsign=false commit -qam "fake 1 (clobber $C1)"
git -C "$REPO_DIR" checkout -q -b test/smoke-fake-2 upstream/main~4
printf 'smoke fixture rewrite 2 — force a merge conflict vs upstream/main\n' > "$REPO_DIR/$C2"
git -C "$REPO_DIR" -c core.hooksPath="$NO_HOOKS" -c commit.gpgsign=false commit -qam "fake 2 (clobber $C2)"
git -C "$REPO_DIR" checkout -q local/upgrade-hook

TMP_MULTI_REGISTRY="$TMP_DIR/multi.json"
jq '.patches += [{"branch":"test/smoke-fake-1","pr":null,"status":"active"},{"branch":"test/smoke-fake-2","pr":null,"status":"active"}]' \
  "$LIVE_STATE" > "$TMP_MULTI_REGISTRY"

OUT=$(KIMI_PATCH_REPO="$REPO_DIR" KIMI_PATCH_STATE="$TMP_MULTI_REGISTRY" DRY_RUN=1 bash "$PIPELINE" 2>&1 || true)
if printf '%s\n' "$OUT" | grep -q "patch test/smoke-fake-1 has merge conflicts" \
  && printf '%s\n' "$OUT" | grep -q "patch test/smoke-fake-2 has merge conflicts"; then
  pass "both conflicting branches reported in single exit message"
else
  fail "multi-conflict gate did not report both branches: $OUT"
fi
# The fixtures never leave this machine, so they must still resolve locally.
if printf '%s\n' "$OUT" | grep -q "patch test/smoke-fake-1: using test/smoke-fake-1"; then
  pass "local-only branch resolves to the local ref"
else
  fail "local-only branch was not resolved from the local ref: $OUT"
fi

# 5. Origin is authoritative: a strictly-behind local branch is built from
#    origin and fast-forwarded to it.
echo "5. origin sourcing + local catch-up"
SYNC_BRANCH=fix/wsl-clipboard-bmp
SYNC_ORIG=$(git -C "$REPO_DIR" rev-parse --verify --quiet "refs/remotes/origin/$SYNC_BRANCH" || true)
SYNC_ORIGINAL=$(git -C "$REPO_DIR" rev-parse --verify --quiet "refs/heads/$SYNC_BRANCH" || true)
if [ -z "$SYNC_ORIG" ] || [ -z "$SYNC_ORIGINAL" ]; then
  fail "fixture branch $SYNC_BRANCH must exist both locally and on origin"
else
  SHORT_ORIG=$(git -C "$REPO_DIR" rev-parse --short "$SYNC_ORIG")
  git -C "$REPO_DIR" branch -f "$SYNC_BRANCH" "refs/remotes/origin/$SYNC_BRANCH~1"
  OUT=$(KIMI_PATCH_REPO="$REPO_DIR" DRY_RUN=1 bash "$PIPELINE" 2>&1 || true)
  if printf '%s\n' "$OUT" | grep -q "patch $SYNC_BRANCH: using origin/$SYNC_BRANCH ($SHORT_ORIG)"; then
    pass "behind local branch is built from origin"
  else
    fail "pipeline did not resolve $SYNC_BRANCH from origin: $OUT"
  fi
  if [ "$(git -C "$REPO_DIR" rev-parse "refs/heads/$SYNC_BRANCH")" = "$SYNC_ORIG" ]; then
    pass "behind local branch was fast-forwarded to origin"
  else
    fail "local $SYNC_BRANCH was not synced to origin"
  fi

  # 6. A local branch ahead of origin keeps its unpushed commit, and the run
  # says so instead of silently building something else.
  echo "6. local-ahead branch is reported, never clobbered"
  AHEAD_SHA=$(git -C "$REPO_DIR" -c user.name=smoke -c user.email=smoke@example.test \
    commit-tree "$SYNC_ORIG^{tree}" -p "$SYNC_ORIG" -m "smoke: unpushed local commit")
  SHORT_AHEAD=$(git -C "$REPO_DIR" rev-parse --short "$AHEAD_SHA")
  git -C "$REPO_DIR" branch -f "$SYNC_BRANCH" "$AHEAD_SHA"
  OUT=$(KIMI_PATCH_REPO="$REPO_DIR" DRY_RUN=1 bash "$PIPELINE" 2>&1 || true)
  if printf '%s\n' "$OUT" | grep -q "note: local $SYNC_BRANCH ($SHORT_AHEAD) differs from origin ($SHORT_ORIG)"; then
    pass "local-ahead branch is reported with the dev-flag hint"
  else
    fail "local-ahead branch was not reported: $OUT"
  fi
  if [ "$(git -C "$REPO_DIR" rev-parse "refs/heads/$SYNC_BRANCH")" = "$AHEAD_SHA" ]; then
    pass "local-ahead branch kept its unpushed commit"
  else
    fail "local-ahead branch was clobbered"
  fi

  # 7. KIMI_PATCH_LOCAL=1 sources the local branches (the development loop).
  echo "7. development flag sources local branches"
  OUT=$(KIMI_PATCH_REPO="$REPO_DIR" KIMI_PATCH_LOCAL=1 DRY_RUN=1 bash "$PIPELINE" 2>&1 || true)
  if printf '%s\n' "$OUT" | grep -q "KIMI_PATCH_LOCAL=1 — sourcing patch branches from local branches"; then
    pass "dev flag announces local sourcing"
  else
    fail "dev flag did not announce local sourcing: $OUT"
  fi
  if printf '%s\n' "$OUT" | grep -q "patch $SYNC_BRANCH: using $SYNC_BRANCH ($SHORT_AHEAD)"; then
    pass "dev flag builds the local head, including the unpushed commit"
  else
    fail "dev flag did not resolve the local head: $OUT"
  fi

  git -C "$REPO_DIR" branch -f "$SYNC_BRANCH" "$SYNC_ORIGINAL"
fi

echo "=== Summary: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
