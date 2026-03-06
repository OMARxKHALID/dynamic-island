#!/bin/bash

# sync.sh — Sync Dynamic Island extension to GNOME extensions directory
# This script copies the current extension files to the local GNOME extensions folder
# and ensures the directory structure is correct.

UUID="dynamic-island@omarxkhalid.github.io"
DEST_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC_DIR="$(dirname "$(readlink -f "$0")")"

echo "🚀 Syncing extension $UUID..."

# 1. Create destination directory if it doesn't exist
mkdir -p "$DEST_DIR"

# 2. Copy extension files
# We exclude the .git directory and the sync script itself
cp -rv "$SRC_DIR"/*.js "$DEST_DIR/"
cp -rv "$SRC_DIR"/*.json "$DEST_DIR/"
cp -rv "$SRC_DIR"/*.css "$DEST_DIR/"
cp -rv "$SRC_DIR/schemas" "$DEST_DIR/"

# 3. Compile schemas (required for settings to work)
echo "🔨 Compiling GSettings schemas..."
glib-compile-schemas "$DEST_DIR/schemas/"

echo "✅ Sync complete!"
echo "💡 To apply changes:"
echo "   1. Press Alt+F2, type 'r', and hit Enter (X11 only)"
echo "   2. Or log out and log back in (Wayland)"
echo "   3. Enable via: gnome-extensions enable $UUID"
