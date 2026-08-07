#!/usr/bin/env bash
# install.sh — install the patched-upgrade hook script and patch registry into ~/.kimi-code.
# An existing script is kept unless FORCE=1 is set. The bundled local-patches.json is the
# canonical registry for this patch set; an existing one is backed up before overwriting.
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

if [ -e "$DEST_DIR/local-patches.json" ]; then
  BACKUP="$DEST_DIR/local-patches.json.bak.$(date +%Y%m%d%H%M%S)"
  cp "$DEST_DIR/local-patches.json" "$BACKUP"
  echo "backed up existing $DEST_DIR/local-patches.json to $BACKUP"
fi
cp "$SRC_DIR/local-patches.json" "$DEST_DIR/local-patches.json"
echo "installed $DEST_DIR/local-patches.json"
