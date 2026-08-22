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
  git -C "$REPO_DIR" checkout -q "$START_BRANCH" 2>/dev/null || true
  git -C "$REPO_DIR" branch -D test/smoke-fake-1 test/smoke-fake-2 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "=== Patched-Upgrade Smoke Tests ==="

# 1. Clean DRY_RUN with real state (must pass merge-tree and exit 0 at DRY_RUN stop)
echo "1. clean DRY_RUN against live state"
if OUT=$(KIMI_PATCH_REPO="$REPO_DIR" DRY_RUN=1 bash "$PIPELINE" 2>&1); then
  if printf '%s\n' "$OUT" | grep -q "DRY_RUN=1 — stopping before build"; then
    pass "clean DRY_RUN stops at the build gate"
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
cp "$PIPELINE" "$TMP_DIR/.kimi-code/upgrade-with-patches.sh"
chmod +x "$TMP_DIR/.kimi-code/upgrade-with-patches.sh"
cp "$SCRIPT_DIR/../skills/resolve-upgrade-conflicts/SKILL.md" "$TMP_DIR/.kimi-code/skills/resolve-upgrade-conflicts/SKILL.md"

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
git -C "$REPO_DIR" checkout -q -b test/smoke-fake-1 upstream/main~4
printf 'smoke fixture rewrite 1 — force a merge conflict vs upstream/main\n' > "$REPO_DIR/$C1"
git -C "$REPO_DIR" commit -qam "fake 1 (clobber $C1)"
git -C "$REPO_DIR" checkout -q -b test/smoke-fake-2 upstream/main~4
printf 'smoke fixture rewrite 2 — force a merge conflict vs upstream/main\n' > "$REPO_DIR/$C2"
git -C "$REPO_DIR" commit -qam "fake 2 (clobber $C2)"
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

echo "=== Summary: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
