#!/usr/bin/env bash
# install.sh — install the patched-upgrade hook script, its companion skill, and the
# patch registry into ~/.kimi-code. An existing script or skill is kept unless FORCE=1
# is set. The bundled local-patches.json is the canonical registry for this patch set;
# an existing one is backed up before overwriting.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/.kimi-code"
mkdir -p "$DEST_DIR"

if [ -e "$DEST_DIR/upgrade-with-patches.sh" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "keeping existing $DEST_DIR/upgrade-with-patches.sh (FORCE=1 to overwrite)"
else
  cp "$SRC_DIR/upgrade-with-patches.sh" "$DEST_DIR/upgrade-with-patches.sh"
  chmod +x "$DEST_DIR/upgrade-with-patches.sh"
  echo "installed $DEST_DIR/upgrade-with-patches.sh"
fi

# Companion skill: guides an agent through resolving the conflicts this pipeline
# reports. Lives at <KIMI_CODE_HOME>/skills/<name>/SKILL.md (user scope).
SKILL_DIR="$DEST_DIR/skills/resolve-upgrade-conflicts"
if [ -e "$SKILL_DIR/SKILL.md" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "keeping existing $SKILL_DIR/SKILL.md (FORCE=1 to overwrite)"
else
  mkdir -p "$SKILL_DIR"
  cp "$SRC_DIR/skills/resolve-upgrade-conflicts/SKILL.md" "$SKILL_DIR/SKILL.md"
  echo "installed $SKILL_DIR/SKILL.md"
fi

if [ -e "$DEST_DIR/local-patches.json" ]; then
  BACKUP="$DEST_DIR/local-patches.json.bak.$(date +%Y%m%d%H%M%S)"
  cp "$DEST_DIR/local-patches.json" "$BACKUP"
  echo "backed up existing $DEST_DIR/local-patches.json to $BACKUP"
fi
cp "$SRC_DIR/local-patches.json" "$DEST_DIR/local-patches.json"
echo "installed $DEST_DIR/local-patches.json"

# Record the repo this checkout belongs to. The pipeline resolves its build
# workspace from `.state.repoPath` (env KIMI_PATCH_REPO overrides). It lives in
# `state`, which the upgrade self-check deliberately excludes as per-machine
# data, so the versioned hook script never carries machine-specific paths.
REPO_ROOT="$(cd "$SRC_DIR/../.." && pwd)"
TMP="$(mktemp)"
jq --arg rp "$REPO_ROOT" '.state.repoPath = $rp' "$DEST_DIR/local-patches.json" > "$TMP" && mv "$TMP" "$DEST_DIR/local-patches.json"
echo "recorded repo path $REPO_ROOT in $DEST_DIR/local-patches.json (.state.repoPath)"
