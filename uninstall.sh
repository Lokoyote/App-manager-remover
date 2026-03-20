#!/bin/bash
# ──────────────────────────────────────────────────
# App Manager — Uninstall Script
# Disables and removes the extension files.
# ──────────────────────────────────────────────────

EXT_UUID="app-manager@custom"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "→ Disabling extension…"
gnome-extensions disable "$EXT_UUID" 2>/dev/null || true

echo "→ Removing $EXT_DIR…"
rm -rf "$EXT_DIR"

echo "✓ Extension removed. Restart GNOME Shell to complete."
