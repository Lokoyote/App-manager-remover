# App Manager Remover — GNOME Shell Extension

A unified application manager for GNOME Shell that lists all user-installed applications — whether they come from **Flatpak**, **Snap**, or **Deb** packages — in a single, searchable floating panel with one-click uninstall.

Built for GNOME Shell **45 / 46 / 47** (Ubuntu 23.10+, Fedora 39+, and other modern GNOME distributions).

---

## Features

- **Unified app list** — All user-facing applications from all packaging formats in one place, sorted alphabetically.
- **Source badges** — Each app displays a colored badge indicating its origin:
  - 🟠 **DEB** (orange) — Debian/Ubuntu native packages
  - 🟢 **FLATPAK** (green) — Flatpak applications
  - 🟣 **SNAP** (purple) — Snap packages
- **Real-time search** — Instantly filter apps by name as you type.
- **Source filter buttons** — Toggle between All / Deb / Flatpak / Snap views.
- **One-click uninstall** — Each app has a trash button that opens a confirmation dialog, then runs the appropriate removal command with password authentication via `pkexec` (PolicyKit).
- **System protection** — A 6-layer filtering strategy ensures that system components, runtime libraries, and essential packages are never shown or removable.

---

## Screenshots

!(App-manager-remover.png)
---

## Installation

### From Source

```bash
git clone https://github.com/YOUR_USERNAME/gnome-app-manager.git
cd gnome-app-manager
chmod +x install.sh
./install.sh
```

Then restart GNOME Shell:

- **X11**: Press `Alt+F2`, type `r`, press Enter
- **Wayland**: Log out and log back in

### Manual Installation

```bash
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/app-manager@custom"
mkdir -p "$EXT_DIR"
cp metadata.json extension.js stylesheet.css "$EXT_DIR/"
gnome-extensions enable app-manager@custom
```

---

## Uninstallation

```bash
chmod +x uninstall.sh
./uninstall.sh
```

Or manually:

```bash
gnome-extensions disable app-manager@custom
rm -rf ~/.local/share/gnome-shell/extensions/app-manager@custom
```

---

## How It Works

### App Discovery

The extension queries `Shell.AppSystem.get_installed()` to get all known `.desktop` entries, then applies a **6-layer filtering strategy** to separate user applications from system components:

| Layer | What it checks | What it rejects |
|-------|---------------|-----------------|
| **1. Desktop metadata** | `NoDisplay`, `Hidden`, missing name or icon | Background services, helper entries |
| **2. XDG categories** | Whether the app has *only* system categories | Pure settings/system entries (but keeps apps like GIMP that have *both* system and user categories) |
| **3. Desktop-ID patterns** | Known prefixes (`org.freedesktop.*`, `org.gnome.shell.*`…) and infixes (`nm-connection-editor`, `update-manager`…) | GNOME core components, Ubuntu system utilities, input method tools |
| **4. Flatpak** | `flatpak list --app` | Runtimes, SDKs, and platform extensions (excluded by Flatpak's own `--app` flag) |
| **5. Snap** | Known system snap names and patterns (`core*`, `gnome-*-*`, `snapd`, `bare`…) | Runtime snaps, base snaps, and platform snaps |
| **6. Deb (at uninstall)** | `dpkg-query` Priority, Essential, and Section fields | Essential packages, required/important priority, system sections (libs, kernel, admin…) |

### Uninstall Commands

| Source | Command | Authentication |
|--------|---------|---------------|
| Flatpak | `flatpak uninstall --noninteractive -y <app-id>` | None required |
| Snap | `pkexec snap remove <snap-name>` | Password via PolicyKit |
| Deb | `pkexec apt remove -y <package>` | Password via PolicyKit |

The extension uses `apt remove` (not `apt purge`) so configuration files are preserved.

### Safety Measures

- **Per-app isolation**: Each application is processed inside its own `try/catch` during discovery. One broken `.desktop` entry never crashes the entire list.
- **Deferred dpkg queries**: Package name resolution and protection checks for Deb packages happen at uninstall-time, not listing-time, keeping the panel fast and responsive.
- **Double-check at uninstall**: Even if a Deb package passes all listing filters, its `Priority`, `Essential`, and `Section` are re-verified the moment the user clicks "Uninstall".
- **GJS compatibility fallbacks**: The `NoDisplay` check uses a 3-level fallback chain (`get_nodisplay()` → `get_boolean()` → `get_string()`) to support all GNOME 45–47 GJS versions.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  PanelMenu.Button (Indicator)               │
│  Grid icon in the top bar                   │
│  Toggles the floating window on click       │
└──────────────────┬──────────────────────────┘
                   │
        ┌──────────▼──────────┐
        │     Backdrop        │
        │  (transparent,      │
        │   catches outside   │
        │   clicks to close)  │
        └──────────┬──────────┘
                   │
    ┌──────────────▼──────────────┐
    │    AppManagerWindow         │
    │  ┌────────────────────┐    │
    │  │ Header + Close btn │    │
    │  ├────────────────────┤    │
    │  │ Search entry       │    │
    │  ├────────────────────┤    │
    │  │ Filter buttons     │    │
    │  │ [All][Deb][Flat…]  │    │
    │  ├────────────────────┤    │
    │  │ App count          │    │
    │  ├────────────────────┤    │
    │  │ ScrollView         │    │
    │  │ ┌────────────────┐ │    │
    │  │ │ AppRow         │ │    │
    │  │ │ Icon+Name+Badge│ │    │
    │  │ │ [🗑 Uninstall] │ │    │
    │  │ ├────────────────┤ │    │
    │  │ │ AppRow         │ │    │
    │  │ │ ...            │ │    │
    │  │ └────────────────┘ │    │
    │  └────────────────────┘    │
    └────────────────────────────┘
```

**Why a floating window instead of PopupMenu?**

GNOME Shell's `PopupMenu` is designed for simple menu items, not complex widget trees with `ScrollView`, dynamic children, and nested layouts. Using `PopupBaseMenuItem` with embedded `St.BoxLayout` trees causes silent rendering failures where the popup appears but its children are invisible. The floating window approach (added via `Main.layoutManager.addTopChrome()`) gives full control over the widget tree and renders reliably.

---

## File Structure

```
app-manager@custom/
├── metadata.json      # Extension metadata (name, UUID, GNOME versions)
├── extension.js       # Main extension logic (700 lines, fully commented)
├── stylesheet.css     # GNOME Shell CSS styles
├── install.sh         # One-command installation script
├── uninstall.sh       # One-command removal script
└── README.md          # This file
```

---

## Requirements

- **GNOME Shell 45, 46, or 47**
- **Flatpak** (optional — Flatpak apps are listed only if `flatpak` is installed)
- **Snapd** (optional — Snap apps are listed only if `snap` is installed)
- **PolicyKit / pkexec** (pre-installed on Ubuntu/Fedora — used for authenticated uninstalls)

---

## Debugging

View extension logs in real time:

```bash
journalctl -f /usr/bin/gnome-shell 2>&1 | grep app-manager
```

On a successful open, you should see:

```
app-manager: found 42 user apps out of 128 total entries
```

If specific apps fail to load:

```
app-manager: skipping app #17: some error message
```

To restart GNOME Shell after changes (X11 only):

```bash
busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…")'
```

---

## Contributing

Contributions are welcome! Here are some ideas:

- **Translations**: The UI strings in `extension.js` can be extracted to `.po` files using GNOME's `gettext` system.
- **App size display**: Show the disk space used by each app alongside its name.
- **Batch uninstall**: Allow selecting multiple apps for removal in one operation.
- **Custom exclusion list**: Let users whitelist/blacklist specific apps from appearing.

---

## License

This project is licensed under the **GPL-3.0-or-later** — see the [LICENSE](LICENSE) file for details.
