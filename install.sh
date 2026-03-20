#!/bin/bash
# ──────────────────────────────────────────────────
# App Manager — Installation Script
# Copies extension files and enables the extension.
# ──────────────────────────────────────────────────

set -e

EXT_UUID="app-manager@custom"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "╔══════════════════════════════════════════════╗"
echo "║       App Manager — Installation             ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 1. Copy extension files to the local extensions directory
echo "→ Copying files to $EXT_DIR…"
mkdir -p "$EXT_DIR"
cp -v metadata.json extension.js stylesheet.css "$EXT_DIR/"

# 2. Enable the extension via gnome-extensions CLI
echo ""
echo "→ Enabling extension…"
gnome-extensions enable "$EXT_UUID" 2>/dev/null || true

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Installation complete!                      ║"
echo "║                                              ║"
echo "║  Restart GNOME Shell to activate:            ║"
echo "║  • X11:    press Alt+F2, type 'r', Enter     ║"
echo "║  • Wayland: log out and log back in          ║"
echo "║                                              ║"
echo "║  Verify with:                                ║"
echo "║    gnome-extensions info $EXT_UUID            ║"
echo "╚══════════════════════════════════════════════╝"
