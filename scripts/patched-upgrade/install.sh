#!/usr/bin/env bash
# install.sh — install the patched-upgrade hook script into ~/.kimi-code.
# An existing script is kept unless FORCE=1 is set. The patch registry is
# live-only config (not versioned); an empty skeleton is seeded when missing.
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

if [ ! -e "$DEST_DIR/local-patches.json" ]; then
  printf '{\n  "patches": []\n}\n' > "$DEST_DIR/local-patches.json"
  echo "created empty $DEST_DIR/local-patches.json — edit it to list your patch branches"
else
  echo "keeping existing $DEST_DIR/local-patches.json"
fi
