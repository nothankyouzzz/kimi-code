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
cleanup() {
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

# 3. Self-check: registry missing branch warns by default, dies under strict
echo "3. self-check: registry drift"
TMP_REGISTRY="$TMP_DIR/patches.json"
jq 'del(.patches[] | select(.branch == "fix/wsl-clipboard-bmp"))' "$LIVE_STATE" > "$TMP_REGISTRY"

OUT=$(KIMI_PATCH_REPO="$REPO_DIR" KIMI_PATCH_STATE="$TMP_REGISTRY" DRY_RUN=1 bash "$PIPELINE" 2>&1 || true)
if printf '%s\n' "$OUT" | grep -q "only-in-repo: fix/wsl-clipboard-bmp"; then
  pass "registry drift warns under default mode"
else
  fail "registry drift did not warn: $OUT"
fi

if OUT=$(KIMI_PATCH_REPO="$REPO_DIR" KIMI_PATCH_STATE="$TMP_REGISTRY" KIMI_UPGRADE_STRICT_SELFCHECK=1 DRY_RUN=1 \
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
# Create two fixture branches whose upstream/main counterpart has real changes:
# 1. bumps package.json version to a conflicting value
git -C "$REPO_DIR" checkout -q -b test/smoke-fake-1 upstream/main~4
sed -i 's/"version": "0.37.1"/"version": "9.9.9"/' "$REPO_DIR/apps/kimi-code/package.json"
git -C "$REPO_DIR" commit -qam "fake 1"
# 2. rewrites the changelog top header (upstream added a release entry at line 9)
git -C "$REPO_DIR" checkout -q -b test/smoke-fake-2 upstream/main~4
sed -i '/^#/d' "$REPO_DIR/docs/en/release-notes/changelog.md"
sed -i '1i # Fake conflict 2' "$REPO_DIR/docs/en/release-notes/changelog.md"
git -C "$REPO_DIR" commit -qam "fake 2"
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
