#!/usr/bin/env bash
# install-stash.sh — Dynamic Island File Stash installer
# Run once from the extension directory:
#   chmod +x install-stash.sh && ./install-stash.sh

set -euo pipefail

BOLD=$(tput bold 2>/dev/null || true)
RESET=$(tput sgr0 2>/dev/null || true)
GREEN="\033[0;32m"
RED="\033[0;31m"
NC="\033[0m"

ok()  { echo -e "${GREEN}✓${NC} $*"; }
err() { echo -e "${RED}✗${NC} $*"; }
hdr() { echo -e "\n${BOLD}$*${RESET}"; }

# ── 1. Check python3-nautilus ─────────────────────────────────────────────────
hdr "Checking dependencies..."
if dpkg -s python3-nautilus &>/dev/null; then
    ok "python3-nautilus is installed"
else
    echo "  python3-nautilus not found — installing..."
    sudo apt-get install -y python3-nautilus
    ok "python3-nautilus installed"
fi

# ── 2. Install the Nautilus extension ─────────────────────────────────────────
hdr "Installing Nautilus extension..."
NAUTILUS_EXT_DIR="$HOME/.local/share/nautilus-python/extensions"
mkdir -p "$NAUTILUS_EXT_DIR"
cp nautilus-stash.py "$NAUTILUS_EXT_DIR/nautilus-stash.py"
chmod 644 "$NAUTILUS_EXT_DIR/nautilus-stash.py"
ok "Installed: $NAUTILUS_EXT_DIR/nautilus-stash.py"

# ── 3. Copy the stash.js module into the extension's src/ ────────────────────
hdr "Installing stash.js module..."
UUID="dynamic-island@omarxkhalid.github.io"
DEST_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [[ -d "$DEST_DIR/src" ]]; then
    cp src/stash.js "$DEST_DIR/src/stash.js"
    ok "Installed: $DEST_DIR/src/stash.js"
else
    err "Could not find extension directory at $DEST_DIR/src"
    echo "  Make sure you've synced the extension using ./sync.sh first."
    exit 1
fi

# ── 4. Restart Nautilus ───────────────────────────────────────────────────────
hdr "Restarting Nautilus..."
nautilus -q 2>/dev/null || true
sleep 1
# Re-launch Nautilus in the background
nohup nautilus --no-desktop &>/dev/null &
ok "Nautilus restarted"

# ── 5. Remind user to reload the shell extension ─────────────────────────────
hdr "Next step: reload the GNOME Shell extension"
echo ""
echo "  Run this command, OR press Alt+F2, type 'r', press Enter (X11 only):"
echo "  On Wayland (Zorin 18 default) you must log out and log back in."
echo ""
ok "Installation complete!"
echo ""
echo "Usage:"
echo "  • Select files in Nautilus → right-click →  Stash N items in Island"
echo "  • Navigate to destination  → right-click folder background"
echo "    → 📂 Move N items Here   OR   📋 Copy N items Here"
echo "  • 🗑 Clear Island Stash removes all stashed items"
echo ""
