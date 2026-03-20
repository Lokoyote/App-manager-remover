/**
 * App Manager — GNOME Shell Extension
 *
 * A Windows-style application manager that displays all user-installed
 * applications regardless of packaging format (Flatpak, Snap, or Deb)
 * in a unified floating panel, with one-click uninstall capability.
 *
 * Architecture:
 *   - A floating St.BoxLayout window attached to GNOME Shell's top chrome
 *     layer (avoids the limitations of PopupMenu for complex widget trees).
 *   - A transparent Backdrop widget catches outside clicks to dismiss.
 *   - A PanelMenu.Button indicator in the top bar toggles the window.
 *
 * App Discovery — 6-Layer Filtering Strategy:
 *   Layer 1: Desktop entry metadata (NoDisplay, Hidden, missing name/icon)
 *   Layer 2: XDG category analysis (reject entries with only system categories)
 *   Layer 3: Desktop-ID pattern matching (known system prefixes and infixes)
 *   Layer 4: Flatpak — only list applications, not runtimes or SDKs
 *   Layer 5: Snap — exclude base, core, snapd, and runtime snaps
 *   Layer 6: Deb — refuse to uninstall essential/required/system packages
 *
 * Safety:
 *   - Each app is processed inside its own try/catch — one broken entry
 *     never kills the entire list.
 *   - Expensive dpkg queries are deferred to uninstall-time, not listing-time.
 *   - Deb packages are double-checked against dpkg Priority/Essential/Section
 *     at the moment the user confirms removal.
 *   - Authentication is handled by pkexec (PolicyKit), which prompts the
 *     user's password through the system dialog.
 *
 * Compatibility: GNOME Shell 45 / 46 / 47 (ESM module format)
 *
 * @license GPL-3.0-or-later
 */

// ─── GI Imports ──────────────────────────────────────────────────────────────

import GLib    from 'gi://GLib';
import Gio     from 'gi://Gio';
import St      from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell   from 'gi://Shell';

// ─── GNOME Shell UI Imports ──────────────────────────────────────────────────

import * as Main        from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu   from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { Extension }    from 'resource:///org/gnome/shell/extensions/extension.js';


// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — Utility Functions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Execute a shell command synchronously and return trimmed stdout.
 * Returns an empty string on failure (command not found, non-zero exit, etc.).
 * Used for querying package managers (flatpak list, snap list, dpkg-query).
 *
 * @param {string} cmdString — The full command string to execute
 * @returns {string} Trimmed stdout, or '' on error
 */
function runCommand(cmdString) {
    try {
        let [ok, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(cmdString);
        if (ok && exitStatus === 0) {
            return new TextDecoder().decode(stdout).trim();
        }
    } catch (_e) {
        // Silently fail — the command may not exist on this system
        // (e.g. flatpak not installed)
    }
    return '';
}

/**
 * Execute a command asynchronously using Gio.Subprocess (fire-and-forget).
 * Used to launch uninstall commands (pkexec apt remove, flatpak uninstall, etc.)
 * without blocking the GNOME Shell main loop.
 *
 * @param {string[]} argv — Argument vector, e.g. ['pkexec', 'apt', 'remove', '-y', 'pkg']
 */
function runCommandArgv(argv) {
    try {
        let proc = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.NONE,
        });
        proc.init(null);
        proc.wait_async(null, () => {});
    } catch (e) {
        logError(e, 'app-manager: runCommandArgv');
    }
}


// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — App Discovery (6-Layer Filtering)
// ═════════════════════════════════════════════════════════════════════════════

// ─── Layer 2: XDG Category Analysis ─────────────────────────────────────────
//
// Strategy: an app is considered "system-only" if ALL its categories are in
// the system set and NONE are in the user set. This lets apps like GIMP
// (categories: "Graphics;System") pass through, while pure system entries
// like "Settings" or "Core" are excluded.

/** Categories that indicate a system/settings-only entry */
const SYSTEM_ONLY_CATEGORIES = new Set([
    'Settings', 'DesktopSettings', 'HardwareSettings',
    'PackageManager', 'Core', 'Monitor',
]);

/** Categories that represent genuine user-facing activities */
const USER_CATEGORIES = new Set([
    'AudioVideo', 'Audio', 'Video', 'Development', 'Education',
    'Game', 'Graphics', 'Network', 'Office', 'Science', 'Utility',
    'Photography', 'Music', 'Player', 'Recorder', 'IDE', 'WebBrowser',
    'Email', 'Chat', 'InstantMessaging', 'Finance', 'Calendar',
    'ContactManagement', 'Database', 'Spreadsheet', 'WordProcessor',
    'Publishing', 'Presentation', 'Viewer', 'TextEditor',
    'RasterGraphics', 'VectorGraphics', '3DGraphics',
    'Scanning', 'Archiving', 'Compression',
]);

/**
 * Determine whether the app's categories indicate a system-only entry.
 * Returns true only if the app has at least one system category and
 * zero user-facing categories.
 *
 * @param {string} categoryString — Semicolon-separated XDG categories
 * @returns {boolean}
 */
function hasOnlySystemCategories(categoryString) {
    if (!categoryString) return false;
    let cats = categoryString.split(';').map(c => c.trim()).filter(c => c);
    if (cats.length === 0) return false;

    let hasUser = cats.some(c => USER_CATEGORIES.has(c));
    if (hasUser) return false;

    return cats.some(c => SYSTEM_ONLY_CATEGORIES.has(c));
}

// ─── Layer 3: Desktop-ID Pattern Exclusion ──────────────────────────────────
//
// Known desktop-ID prefixes and infixes that belong to system plumbing,
// GNOME core components, Ubuntu system tools, and input method utilities.
// Matched case-insensitively against the full .desktop filename.

/** Reject if the desktop-ID starts with any of these strings */
const EXCLUDED_PREFIXES = [
    'org.freedesktop.', 'org.gnome.settings', 'org.gnome.extensions',
    'org.gnome.terminal', 'org.gnome.console', 'org.gnome.nautilus',
    'org.gnome.systemmonitor', 'org.gnome.logs', 'org.gnome.diskutility',
    'org.gnome.disks', 'org.gnome.font', 'org.gnome.characters',
    'org.gnome.baobab', 'org.gnome.powerstats', 'org.gnome.firmware',
    'org.gnome.tweaks', 'org.gnome.connections', 'org.gnome.clocks',
    'org.gnome.weather', 'org.gnome.maps', 'org.gnome.contacts',
    'org.gnome.calendar', 'org.gnome.snapshot', 'org.gnome.portal',
    'org.gnome.shell.', 'org.gnome.evolution-data', 'org.gtk.',
    'xdg-', 'snap:',
];

/** Reject if the desktop-ID contains any of these substrings */
const EXCLUDED_INFIXES = [
    'nm-connection-editor', 'nm-applet', 'software-properties',
    'update-manager', 'update-notifier', 'gnome-language-selector',
    'gnome-session-properties', 'gnome-initial-setup', 'ibus-setup',
    'im-config', 'fcitx-config', 'input-remapper', 'yelp',
    'info.desktop', 'debian-uxterm', 'debian-xterm', 'display-im6',
    'hwe-support-status', 'apport-gtk', 'ubuntu-report',
    'gnome-system-log', 'systemd-', 'polkit-',
];

/**
 * Check if a desktop-ID matches any known system pattern.
 *
 * @param {string} desktopId — Full desktop file ID (e.g. "org.gnome.Nautilus.desktop")
 * @returns {boolean}
 */
function matchesSystemPattern(desktopId) {
    let id = desktopId.toLowerCase();
    for (let p of EXCLUDED_PREFIXES)
        if (id.startsWith(p.toLowerCase())) return true;
    for (let p of EXCLUDED_INFIXES)
        if (id.includes(p.toLowerCase())) return true;
    return false;
}

// ─── Layer 4: Flatpak App Detection ─────────────────────────────────────────

/**
 * Build a Set of installed Flatpak application IDs (reverse-DNS format).
 * The --app flag already excludes runtimes, SDKs, and extensions.
 * Returns an empty set if flatpak is not installed.
 *
 * @returns {Set<string>}
 */
function getFlatpakIds() {
    let set = new Set();
    let out = runCommand('flatpak list --app --columns=application');
    if (out) {
        for (let line of out.split('\n')) {
            let id = line.trim();
            if (id) set.add(id);
        }
    }
    return set;
}

// ─── Layer 5: Snap App Detection ────────────────────────────────────────────
//
// Snap does not expose a "type" column in `snap list`, so we maintain a
// known-list of system/runtime snap names plus regex patterns to filter
// out infrastructure snaps (core, gnome platform, gtk themes, etc.).

/** Well-known snap names that are system infrastructure, not user apps */
const SNAP_SYSTEM_NAMES = new Set([
    'bare', 'core', 'core18', 'core20', 'core22', 'core24',
    'gnome-3-28-1804', 'gnome-3-34-1804', 'gnome-3-38-2004',
    'gnome-42-2204', 'gnome-46-2404', 'gtk-common-themes',
    'snapd', 'snap-store', 'firmware-updater',
]);

/** Regex patterns matching system snap naming conventions */
const SNAP_SYSTEM_PATTERNS = [
    /^core\d*$/,        // core, core20, core22, ...
    /^gnome-\d/,        // gnome-42-2204, gnome-3-38-2004, ...
    /^gtk-common/,      // gtk-common-themes
    /^kde-frameworks/,  // KDE runtime snaps
    /^snapd-desktop/,   // snapd desktop integration
    /^mesa-/,           // Mesa GPU drivers
    /^snapcraft$/,      // Build tool, not a user app
];

/**
 * Determine if a snap name belongs to system infrastructure.
 *
 * @param {string} name — Snap package name
 * @returns {boolean}
 */
function isSystemSnap(name) {
    let n = name.toLowerCase();
    if (SNAP_SYSTEM_NAMES.has(n)) return true;
    for (let re of SNAP_SYSTEM_PATTERNS)
        if (re.test(n)) return true;
    return false;
}

/**
 * Build a Map of installed snap names (lowercase → original case),
 * excluding system/runtime snaps.
 *
 * @returns {Map<string, string>}
 */
function getSnapNames() {
    let map = new Map();
    let out = runCommand('snap list');
    if (out) {
        let lines = out.split('\n');
        // Skip the header line ("Name  Version  Rev  ...")
        for (let i = 1; i < lines.length; i++) {
            let parts = lines[i].trim().split(/\s+/);
            if (parts.length === 0 || !parts[0]) continue;
            let name = parts[0];
            if (isSystemSnap(name)) continue;
            map.set(name.toLowerCase(), name);
        }
    }
    return map;
}

// ─── Layer 6: Deb Package Protection ────────────────────────────────────────
//
// Ensures essential system packages can never be uninstalled through the UI.
// This check is performed at uninstall-time (not listing-time) to avoid
// expensive dpkg-query calls for every package on every panel open.

/** dpkg sections that contain system internals, not user applications */
const DEB_SYSTEM_SECTIONS = new Set([
    'libs', 'oldlibs', 'libdevel', 'kernel', 'admin',
    'metapackages', 'tasks', 'debian-installer', 'base', 'shells',
]);

/**
 * Query dpkg to determine if a package is a protected system component.
 * Checks three fields:
 *   - Essential: yes → always protected
 *   - Priority: required or important → protected
 *   - Section: libs, kernel, admin, etc. → protected
 *
 * @param {string} pkgName — Debian package name
 * @returns {boolean} True if the package should NOT be uninstalled
 */
function isProtectedDebPackage(pkgName) {
    if (!pkgName) return false;

    let out = runCommand(
        `dpkg-query -W -f='\${Priority}||||\${Essential}||||\${Section}' ${pkgName}`
    );
    if (!out) return false;

    let parts = out.split('||||');
    let priority  = (parts[0] || '').trim().toLowerCase();
    let essential = (parts[1] || '').trim().toLowerCase();
    let section   = (parts[2] || '').trim().toLowerCase();

    // Strip component prefix (e.g. "universe/utils" → "utils")
    if (section.includes('/')) section = section.split('/').pop();

    if (essential === 'yes') return true;
    if (priority === 'required' || priority === 'important') return true;
    if (DEB_SYSTEM_SECTIONS.has(section)) return true;

    return false;
}

/**
 * Resolve the Debian package name that owns a given .desktop file path.
 * Uses `dpkg -S <path>` which returns "package-name: /path/to/file".
 *
 * @param {string} desktopFilePath — Absolute path to the .desktop file
 * @returns {string|null} Package name, or null if unresolvable
 */
function debPackageForDesktop(desktopFilePath) {
    if (!desktopFilePath) return null;

    let out = runCommand(`dpkg -S "${desktopFilePath}"`);
    if (out) {
        let match = out.split(':')[0];
        if (match && !match.includes(' ')) return match.trim();
    }
    return null;
}


// ─── Master Collection Function ─────────────────────────────────────────────

/**
 * Collect all user-facing applications from the GNOME Shell app system,
 * applying the 6-layer filtering strategy to exclude system components.
 *
 * Key design decisions:
 *   - Each app is wrapped in its own try/catch so one broken .desktop
 *     entry never kills the entire list.
 *   - The NoDisplay check uses a 3-level fallback chain because the
 *     GDesktopAppInfo API varies across GJS/GNOME versions:
 *       1. get_nodisplay()  — GNOME 45+
 *       2. get_boolean('NoDisplay') — older GJS
 *       3. get_string('NoDisplay') — last resort
 *   - No dpkg queries are made during listing — they are deferred to
 *     uninstall-time to keep the panel responsive.
 *
 * @returns {Array<Object>} Sorted array of app objects:
 *   { name, iconName, source: 'flatpak'|'snap'|'deb',
 *     uninstallId, desktopId, desktopPath }
 */
function collectApps() {
    let appSystem = Shell.AppSystem.get_default();
    let allApps = appSystem.get_installed();

    // Pre-fetch package manager data (one call each, cached for this session)
    let flatpakIds = getFlatpakIds();
    let snapNames  = getSnapNames();
    let results    = [];

    for (let i = 0; i < allApps.length; i++) {
        try {
            let app = allApps[i];
            let id = app.get_id();
            if (!id) continue;

            let appInfo = app.get_app_info();
            if (!appInfo) continue;

            // ── Layer 1: Desktop entry metadata ──
            //
            // Reject entries marked as hidden, having no display name,
            // or missing an icon (indicates a backend service, not a UI app).

            // NoDisplay — 3-level fallback for GJS compatibility
            let noDisplay = false;
            try { noDisplay = appInfo.get_nodisplay(); } catch (_e1) {
                try { noDisplay = appInfo.get_boolean('NoDisplay'); } catch (_e2) {
                    try {
                        let nd = appInfo.get_string('NoDisplay');
                        noDisplay = (nd !== null && nd.toLowerCase() === 'true');
                    } catch (_e3) { /* assume visible */ }
                }
            }
            if (noDisplay) continue;

            // Hidden check
            let hidden = false;
            try { hidden = appInfo.get_boolean('Hidden'); } catch (_e) {
                try {
                    let h = appInfo.get_string('Hidden');
                    hidden = (h !== null && h.toLowerCase() === 'true');
                } catch (_e2) { /* assume not hidden */ }
            }
            if (hidden) continue;

            // Require a display name and an icon
            let name = app.get_name();
            if (!name || name.length === 0) continue;

            let icon = null;
            try { icon = appInfo.get_icon(); } catch (_e) { /* pass */ }
            if (!icon) continue;

            let categories = '';
            try { categories = appInfo.get_categories() || ''; } catch (_e) { /* pass */ }

            // ── Layer 2: XDG category analysis ──
            if (hasOnlySystemCategories(categories)) continue;

            // ── Layer 3: Desktop-ID pattern matching ──
            if (matchesSystemPattern(id)) continue;

            // ── Determine packaging source ──

            let iconName = 'application-x-executable';
            try { iconName = icon.to_string(); } catch (_e) { /* keep fallback */ }

            let baseId = id.replace(/\.desktop$/, '');
            let source = 'deb';
            let uninstallId = baseId;

            // Retrieve the .desktop file path for snap detection and
            // deferred deb resolution at uninstall time
            let desktopPath = '';
            try { desktopPath = appInfo.get_filename() || ''; } catch (_e) { /* pass */ }

            // ── Layer 4: Flatpak detection ──
            // Match the desktop ID (minus .desktop) against flatpak --app list
            if (flatpakIds.has(baseId)) {
                source = 'flatpak';
                uninstallId = baseId;

            } else {
                // ── Layer 5: Snap detection ──
                // Primary: check if the .desktop file lives under /snap/ or /snapd/
                // Secondary: match by app name or desktop-ID against snap list
                let snapMatch = false;

                if (desktopPath.includes('/snap/') || desktopPath.includes('/snapd/')) {
                    // Extract snap name from the .desktop filename:
                    // e.g. "/var/lib/snapd/desktop/applications/firefox_firefox.desktop"
                    //       → basename "firefox_firefox.desktop" → candidate "firefox"
                    let baseName = GLib.path_get_basename(desktopPath);
                    let candidate = baseName.split('_')[0];
                    if (snapNames.has(candidate.toLowerCase())) {
                        source = 'snap';
                        uninstallId = snapNames.get(candidate.toLowerCase());
                        snapMatch = true;
                    }
                }

                // Fallback: try matching by display name or base ID
                if (!snapMatch) {
                    let nameLower = name.toLowerCase().replace(/\s+/g, '-');
                    if (snapNames.has(nameLower)) {
                        source = 'snap';
                        uninstallId = snapNames.get(nameLower);
                    } else if (snapNames.has(baseId.toLowerCase())) {
                        source = 'snap';
                        uninstallId = snapNames.get(baseId.toLowerCase());
                    }
                }

                // ── Layer 6: Deb — deferred ──
                // We intentionally do NOT call dpkg here to keep listing fast.
                // The actual package name is resolved and protection-checked
                // at uninstall time in _doUninstall().
                if (source === 'deb') {
                    uninstallId = baseId;
                }
            }

            results.push({ name, iconName, source, uninstallId, desktopId: id, desktopPath });

        } catch (e) {
            // CRITICAL: one broken app must NEVER kill the entire list.
            // Log the error for debugging, skip to the next entry.
            log(`app-manager: skipping app #${i}: ${e.message}`);
            continue;
        }
    }

    results.sort((a, b) => a.name.localeCompare(b.name));
    log(`app-manager: found ${results.length} user apps out of ${allApps.length} total entries`);
    return results;
}


// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — Confirmation Dialog
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Modal dialog that asks the user to confirm an uninstall action.
 * Displays the app name, packaging source, and package identifier.
 * Calls onConfirm() only when the user explicitly clicks "Uninstall".
 */
const ConfirmDialog = GObject.registerClass(
class ConfirmDialog extends ModalDialog.ModalDialog {

    /**
     * @param {string} appName     — Human-readable application name
     * @param {string} source      — Packaging source ('flatpak', 'snap', 'deb')
     * @param {string} uninstallId — Package identifier used for removal
     * @param {Function} onConfirm — Callback executed on confirmation
     */
    _init(appName, source, uninstallId, onConfirm) {
        super._init({ styleClass: 'app-manager-confirm-dialog' });

        let content = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 12px; padding: 20px; min-width: 300px;',
        });
        this.contentLayout.add_child(content);

        // Title
        content.add_child(new St.Label({
            text: `Uninstall "${appName}"?`,
            style: 'font-size: 16px; font-weight: bold; text-align: center;',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        // Details
        content.add_child(new St.Label({
            text: [
                `Source: ${source.toUpperCase()}`,
                `Package: ${uninstallId}`,
                '',
                'Your password will be required to proceed.',
            ].join('\n'),
            style: 'font-size: 13px; text-align: center; color: #aaa;',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        this.setButtons([
            {
                label: 'Cancel',
                action: () => this.close(),
                key: Clutter.KEY_Escape,
            },
            {
                label: 'Uninstall',
                action: () => { this.close(); onConfirm(); },
                default: true,
            },
        ]);
    }
});


// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 4 — Floating Application Window
// ═════════════════════════════════════════════════════════════════════════════
//
// We use a floating St.BoxLayout attached to GNOME Shell's top chrome layer
// instead of a PopupMenu. This approach was chosen because PopupMenu cannot
// reliably render complex widget trees (ScrollView with dynamic children),
// which causes the panel to appear empty when using the menu-based approach.

/**
 * The main floating window that displays the application list.
 *
 * Lifecycle:
 *   open()  — positions the window, triggers async app collection,
 *             populates the scrollable list, and focuses the search bar.
 *   close() — hides the window and emits the 'closed' signal so the
 *             backdrop can hide itself.
 *
 * Emits: 'closed' — when the window is dismissed.
 */
const AppManagerWindow = GObject.registerClass({
    Signals: { 'closed': {} },
}, class AppManagerWindow extends St.BoxLayout {

    _init() {
        super._init({
            vertical: true,
            visible: false,
            reactive: true,
            style_class: 'app-manager-window',
        });

        this._apps = [];           // Cached app list from collectApps()
        this._activeFilter = 'all'; // Current source filter ('all', 'deb', 'flatpak', 'snap')
        this._searchText = '';      // Current search query

        this._buildUI();
    }

    /**
     * Construct the full widget tree: header, search bar, filter buttons,
     * count label, and scrollable app list container.
     */
    _buildUI() {
        // ── Header bar with title and close button ──
        let header = new St.BoxLayout({ style_class: 'app-manager-header' });
        this.add_child(header);

        header.add_child(new St.Icon({
            icon_name: 'view-grid-symbolic',
            icon_size: 22,
            style: 'margin-right: 10px;',
        }));

        header.add_child(new St.Label({
            text: 'Applications',
            style_class: 'app-manager-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));

        let closeBtn = new St.Button({
            style_class: 'app-manager-close-btn',
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 }),
        });
        closeBtn.connect('clicked', () => this.close());
        header.add_child(closeBtn);

        // ── Search entry ──
        this._searchEntry = new St.Entry({
            hint_text: '  Search applications…',
            style_class: 'app-manager-search',
            can_focus: true,
        });
        this._searchEntry.get_clutter_text().connect('text-changed', () => {
            this._searchText = this._searchEntry.get_text();
            this._populateList();
        });
        this.add_child(this._searchEntry);

        // ── Source filter buttons ──
        let filterBar = new St.BoxLayout({ style_class: 'app-manager-filters' });
        this.add_child(filterBar);

        this._filterBtns = {};
        for (let { key, label } of [
            { key: 'all',     label: 'All' },
            { key: 'deb',     label: 'Deb' },
            { key: 'flatpak', label: 'Flatpak' },
            { key: 'snap',    label: 'Snap' },
        ]) {
            let btn = new St.Button({
                label,
                style_class: 'app-manager-filter-btn',
                toggle_mode: true,
            });
            if (key === 'all') btn.checked = true;

            btn.connect('clicked', () => {
                this._activeFilter = key;
                // Update toggle states
                for (let [k, b] of Object.entries(this._filterBtns))
                    b.checked = (k === key);
                this._populateList();
            });

            filterBar.add_child(btn);
            this._filterBtns[key] = btn;
        }

        // ── App count label ──
        this._countLabel = new St.Label({
            text: 'Loading…',
            style_class: 'app-manager-count',
        });
        this.add_child(this._countLabel);

        // ── Scrollable application list ──
        this._scrollView = new St.ScrollView({
            style_class: 'app-manager-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._scrollView);

        this._listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'app-manager-list',
            x_expand: true,
        });
        this._scrollView.set_child(this._listBox);
    }

    /**
     * Open the floating window: position it below the top panel,
     * reset filters, and kick off asynchronous app loading.
     */
    open() {
        this.show();
        this._searchEntry.set_text('');
        this._activeFilter = 'all';
        for (let [k, b] of Object.entries(this._filterBtns))
            b.checked = (k === 'all');

        this._countLabel.text = 'Loading…';
        this._listBox.destroy_all_children();

        // Position: anchored to the top-right, just below the panel
        let monitor = Main.layoutManager.primaryMonitor;
        let panelH = Main.panel.get_height();
        let winW = 460;
        let winH = Math.min(monitor.height - panelH - 40, 700);
        this.set_size(winW, winH);
        this.set_position(
            monitor.x + monitor.width - winW - 12,
            monitor.y + panelH + 6
        );

        // Load apps on the next idle cycle to avoid blocking the Shell
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                this._apps = collectApps();
            } catch (e) {
                logError(e, 'app-manager: collectApps');
                this._apps = [];
            }
            this._populateList();

            // Auto-focus the search bar for immediate typing
            global.stage.set_key_focus(this._searchEntry);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Hide the window and notify the backdrop. */
    close() {
        this.hide();
        this.emit('closed');
    }

    /**
     * Rebuild the visible app list based on current filter and search text.
     * Called whenever the user types in the search bar or clicks a filter.
     */
    _populateList() {
        this._listBox.destroy_all_children();
        let search = this._searchText.toLowerCase();
        let count = 0;

        for (let app of this._apps) {
            // Apply source filter
            if (this._activeFilter !== 'all' && app.source !== this._activeFilter)
                continue;
            // Apply search filter
            if (search && !app.name.toLowerCase().includes(search))
                continue;

            this._listBox.add_child(this._makeRow(app));
            count++;
        }

        this._countLabel.text = `${count} application${count !== 1 ? 's' : ''}`;
    }

    /**
     * Create a single app row widget: icon + name/badge + uninstall button.
     *
     * @param {Object} data — App data object from collectApps()
     * @returns {St.BoxLayout}
     */
    _makeRow(data) {
        let row = new St.BoxLayout({
            style_class: 'app-manager-row',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        // App icon (32px, with generic fallback)
        row.add_child(new St.Icon({
            icon_name: data.iconName,
            icon_size: 32,
            style_class: 'app-manager-icon',
            fallback_icon_name: 'application-x-executable',
        }));

        // Name and source badge
        let info = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 3px;' });
        info.add_child(new St.Label({
            text: data.name,
            style_class: 'app-manager-app-name',
            x_align: Clutter.ActorAlign.START,
        }));
        info.add_child(new St.Label({
            text: data.source.toUpperCase(),
            style_class: `app-manager-badge app-manager-badge-${data.source}`,
            x_align: Clutter.ActorAlign.START,
        }));
        row.add_child(info);

        // Uninstall button (trash icon)
        let btn = new St.Button({
            style_class: 'app-manager-uninstall-btn',
            child: new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 16 }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.connect('clicked', () => {
            this.close();
            let dlg = new ConfirmDialog(data.name, data.source, data.uninstallId, () => {
                this._doUninstall(data);
            });
            dlg.open(global.get_current_time());
        });
        row.add_child(btn);

        return row;
    }

    /**
     * Execute the appropriate uninstall command for the given app.
     *
     * - Flatpak: `flatpak uninstall -y <app-id>` (no sudo needed)
     * - Snap:    `pkexec snap remove <snap-name>` (prompts for password)
     * - Deb:     `pkexec apt remove -y <package>` (prompts for password)
     *
     * For deb packages, the actual package name is resolved at this point
     * (deferred from listing-time) and a protection check is performed.
     *
     * @param {Object} data — App data object from collectApps()
     */
    _doUninstall(data) {
        let argv;

        switch (data.source) {
            case 'flatpak':
                argv = ['flatpak', 'uninstall', '--noninteractive', '-y', data.uninstallId];
                break;

            case 'snap':
                argv = ['pkexec', 'snap', 'remove', data.uninstallId];
                break;

            case 'deb': {
                // Resolve the real deb package name from the .desktop path
                // (deferred from collectApps for performance)
                let pkg = data.uninstallId;
                if (data.desktopPath) {
                    let resolved = debPackageForDesktop(data.desktopPath);
                    if (resolved) pkg = resolved;
                }

                // Safety: double-check against dpkg before proceeding
                if (isProtectedDebPackage(pkg)) {
                    Main.notify('App Manager',
                        `${data.name} is a protected system package. Uninstall cancelled.`);
                    return;
                }

                // Use apt remove (NOT purge) to preserve config files
                argv = ['pkexec', 'apt', 'remove', '-y', pkg];
                break;
            }

            default: return;
        }

        Main.notify('App Manager', `Uninstalling ${data.name}…`);
        runCommandArgv(argv);
    }

    /** Allow pressing Escape to dismiss the window. */
    vfunc_key_press_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});


// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 5 — Backdrop (Dismiss-on-outside-click)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A transparent full-screen widget placed behind the floating window.
 * Catches any click outside the window and closes it, mimicking the
 * behavior of a dropdown or popover dismissal.
 */
const Backdrop = GObject.registerClass(
class Backdrop extends St.Widget {
    _init(win) {
        super._init({ reactive: true, visible: false });
        this._win = win;
    }

    vfunc_button_press_event() {
        this._win.close();
        return Clutter.EVENT_STOP;
    }
});


// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 6 — Panel Indicator (Top Bar Button)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The panel button (grid icon) in GNOME Shell's top bar.
 * Clicking it toggles the floating application window.
 *
 * Initialized with `dontCreateMenu = true` (third argument) because we
 * manage our own floating window instead of using PanelMenu's built-in menu.
 */
const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {

    /**
     * @param {AppManagerWindow} win      — The floating window instance
     * @param {Backdrop}         backdrop — The backdrop instance
     */
    _init(win, backdrop) {
        super._init(0.0, 'App Manager', true);
        this._win = win;
        this._bk = backdrop;

        this.add_child(new St.Icon({
            icon_name: 'view-grid-symbolic',
            style_class: 'system-status-icon',
        }));
    }

    /**
     * Intercept click and touch events to toggle the window.
     * We override vfunc_event instead of connecting to 'button-press-event'
     * because PanelMenu.Button with dontCreateMenu=true does not relay
     * standard signal handlers.
     */
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS ||
            event.type() === Clutter.EventType.TOUCH_BEGIN) {
            this._toggle();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Show or hide the floating window and its backdrop. */
    _toggle() {
        if (this._win.visible) {
            this._win.close();
        } else {
            // Size and position the backdrop to cover the screen
            // (starting below the panel so the panel remains clickable)
            let mon = Main.layoutManager.primaryMonitor;
            this._bk.set_position(mon.x, mon.y + Main.panel.get_height());
            this._bk.set_size(mon.width, mon.height);
            this._bk.show();
            this._win.open();
        }
    }
});


// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 7 — Extension Lifecycle
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Main extension class. Manages the lifecycle of all components:
 *   enable()  — creates the window, backdrop, and indicator
 *   disable() — destroys everything cleanly (required by GNOME review policy)
 *
 * All widgets are added to Main.layoutManager.addTopChrome() so they
 * overlay above normal windows and receive input correctly.
 */
export default class AppManagerExtension extends Extension {

    enable() {
        // Create the floating window and its backdrop
        this._win = new AppManagerWindow();
        this._bk  = new Backdrop(this._win);

        // When the window closes, also dismiss the backdrop
        this._win.connect('closed', () => this._bk.hide());

        // Add both to the top chrome layer (above all windows)
        Main.layoutManager.addTopChrome(this._bk);
        Main.layoutManager.addTopChrome(this._win);

        // Add the panel indicator (grid icon in the top bar)
        this._indicator = new Indicator(this._win, this._bk);
        Main.panel.addToStatusArea('app-manager', this._indicator);
    }

    disable() {
        // Clean up in reverse order (required for GNOME Shell extension review)
        if (this._win) {
            Main.layoutManager.removeChrome(this._win);
            this._win.destroy();
            this._win = null;
        }
        if (this._bk) {
            Main.layoutManager.removeChrome(this._bk);
            this._bk.destroy();
            this._bk = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
