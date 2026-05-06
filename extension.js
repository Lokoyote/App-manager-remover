/*
 * App Manager Remover
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Lists user-installed apps (Flatpak, Snap, Deb) in a floating panel
 * and lets you uninstall them with a single click.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';


// -- Async subprocess helpers ----------------------------------------------

/**
 * Run a subprocess and return its trimmed stdout as a Promise<string>.
 * Returns '' on any error (binary missing, non-zero exit, cancellation, ...).
 *
 * @param {string[]} argv - Command + arguments (no shell interpretation).
 * @param {Gio.Cancellable|null} [cancellable]
 * @returns {Promise<string>}
 */
function _spawnAsync(argv, cancellable = null) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (_) {
            // Binary not found, etc.
            resolve('');
            return;
        }

        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                resolve(p.get_successful() ? (stdout || '').trim() : '');
            } catch (_) {
                resolve('');
            }
        });
    });
}

/**
 * Fire-and-forget subprocess (used for uninstall commands that can take
 * arbitrarily long and whose output we don't need).
 *
 * @param {string[]} argv
 */
function _spawnDetached(argv) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        proc.wait_async(null, () => {});
    } catch (_) { /* ignore */ }
}

// GNOME 46+ returns Gio.DesktopAppInfo from get_installed();
// GNOME 45 returns Shell.App (with .get_app_info()).
function _toAppInfo(entry) {
    try {
        if (typeof entry.get_app_info === 'function') {
            const info = entry.get_app_info();
            if (info)
                return info;
        }
    } catch (_) { /* not a Shell.App */ }
    return entry;
}


// -- Category filter --------------------------------------------------------

const _SYSTEM_CATS = new Set([
    'Settings', 'DesktopSettings', 'HardwareSettings',
    'PackageManager', 'Core', 'Monitor',
]);

const _USER_CATS = new Set([
    'AudioVideo', 'Audio', 'Video', 'Development', 'Education',
    'Game', 'Graphics', 'Network', 'Office', 'Science', 'Utility',
    'Photography', 'Music', 'Player', 'Recorder', 'IDE', 'WebBrowser',
    'Email', 'Chat', 'InstantMessaging', 'Finance', 'Calendar',
    'ContactManagement', 'Database', 'Spreadsheet', 'WordProcessor',
    'Publishing', 'Presentation', 'Viewer', 'TextEditor',
    'RasterGraphics', 'VectorGraphics', '3DGraphics',
    'Scanning', 'Archiving', 'Compression',
]);

function _onlySystemCats(raw) {
    if (!raw) return false;
    const cats = raw.split(';').filter(c => c);
    if (cats.some(c => _USER_CATS.has(c))) return false;
    return cats.some(c => _SYSTEM_CATS.has(c));
}


// -- Desktop-ID filter ------------------------------------------------------

const _EX_PREFIXES = [
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

const _EX_INFIXES = [
    'nm-connection-editor', 'nm-applet', 'software-properties',
    'update-manager', 'update-notifier', 'gnome-language-selector',
    'gnome-session-properties', 'gnome-initial-setup', 'ibus-setup',
    'im-config', 'fcitx-config', 'input-remapper', 'yelp',
    'info.desktop', 'debian-uxterm', 'debian-xterm', 'display-im6',
    'hwe-support-status', 'apport-gtk', 'ubuntu-report',
    'gnome-system-log', 'systemd-', 'polkit-',
];

function _isSystemId(desktopId) {
    const lc = desktopId.toLowerCase();
    for (const p of _EX_PREFIXES)
        if (lc.startsWith(p)) return true;
    for (const p of _EX_INFIXES)
        if (lc.includes(p)) return true;
    return false;
}


// -- Flatpak ----------------------------------------------------------------

async function _flatpakIds(cancellable) {
    const s = new Set();
    const out = await _spawnAsync(
        ['flatpak', 'list', '--app', '--columns=application'],
        cancellable);
    if (out)
        out.split('\n').forEach(l => { if (l.trim()) s.add(l.trim()); });
    return s;
}


// -- Snap -------------------------------------------------------------------

const _SNAP_SYS = new Set([
    'bare', 'core', 'core18', 'core20', 'core22', 'core24',
    'gnome-3-28-1804', 'gnome-3-34-1804', 'gnome-3-38-2004',
    'gnome-42-2204', 'gnome-46-2404', 'gtk-common-themes',
    'snapd', 'snap-store', 'firmware-updater',
]);
const _SNAP_RE = [
    /^core\d*$/, /^gnome-\d/, /^gtk-common/, /^kde-frameworks/,
    /^snapd-desktop/, /^mesa-/, /^snapcraft$/,
];

async function _snapNames(cancellable) {
    const map = new Map();
    const out = await _spawnAsync(['snap', 'list'], cancellable);
    if (!out) return map;
    for (const line of out.split('\n').slice(1)) {
        const name = line.trim().split(/\s+/)[0];
        if (!name) continue;
        const lc = name.toLowerCase();
        if (_SNAP_SYS.has(lc) || _SNAP_RE.some(r => r.test(lc))) continue;
        map.set(lc, name);
    }
    return map;
}


// -- Deb protection (checked at uninstall time only) ------------------------

const _DEB_SYS_SECTIONS = new Set([
    'libs', 'oldlibs', 'libdevel', 'kernel', 'admin',
    'metapackages', 'tasks', 'debian-installer', 'base', 'shells',
]);

async function _isProtectedDeb(pkg) {
    if (!pkg) return false;
    const out = await _spawnAsync([
        'dpkg-query', '-W',
        '-f=${Priority}||||${Essential}||||${Section}',
        pkg,
    ]);
    if (!out) return false;
    const [pri, ess, rawSec] = out.split('||||').map(s => s.trim().toLowerCase());
    const sec = rawSec?.includes('/') ? rawSec.split('/').pop() : rawSec;
    if (ess === 'yes') return true;
    if (pri === 'required' || pri === 'important') return true;
    return _DEB_SYS_SECTIONS.has(sec);
}

async function _debPkgForDesktop(path) {
    if (!path) return null;
    // Pass `path` as a separate argv element — no shell interpolation.
    const out = await _spawnAsync(['dpkg', '-S', path]);
    if (!out) return null;
    const pkg = out.split(':')[0];
    return (pkg && !pkg.includes(' ')) ? pkg.trim() : null;
}


// -- App collection ---------------------------------------------------------

async function _collectApps(cancellable) {
    const all = Shell.AppSystem.get_default().get_installed();
    if (!all?.length) return [];

    // Run the two listing commands concurrently — they're independent,
    // so the total wall-clock time is max(flatpak, snap) instead of sum.
    const [fpIds, snaps] = await Promise.all([
        _flatpakIds(cancellable),
        _snapNames(cancellable),
    ]);

    const results = [];

    for (let i = 0; i < all.length; i++) {
        try {
            const info = _toAppInfo(all[i]);

            const id = info.get_id?.() ?? null;
            if (!id) continue;

            // should_show() is the same check GNOME's launcher uses:
            // NoDisplay, Hidden, OnlyShowIn, valid Exec...
            try {
                if (typeof info.should_show === 'function' && !info.should_show())
                    continue;
                else if (typeof info.get_nodisplay === 'function' && info.get_nodisplay())
                    continue;
            } catch (_) { /* assume visible */ }

            const name = info.get_name?.() || info.get_display_name?.() || null;
            if (!name) continue;

            let categories = '';
            try { categories = info.get_categories() || ''; } catch (_) { /**/ }
            if (_onlySystemCats(categories)) continue;
            if (_isSystemId(id)) continue;

            let iconName = 'application-x-executable';
            try {
                const ic = info.get_icon();
                if (ic) iconName = ic.to_string();
            } catch (_) { /**/ }

            const baseId = id.replace(/\.desktop$/, '');
            let source = 'deb', uninstallId = baseId;
            let desktopPath = '';
            try { desktopPath = info.get_filename() || ''; } catch (_) { /**/ }

            if (fpIds.has(baseId)) {
                source = 'flatpak';
                uninstallId = baseId;
            } else {
                let matched = false;
                if (desktopPath.includes('/snap/') || desktopPath.includes('/snapd/')) {
                    const cand = GLib.path_get_basename(desktopPath).split('_')[0];
                    if (snaps.has(cand.toLowerCase())) {
                        source = 'snap';
                        uninstallId = snaps.get(cand.toLowerCase());
                        matched = true;
                    }
                }
                if (!matched) {
                    const nameLc = name.toLowerCase().replace(/\s+/g, '-');
                    if (snaps.has(nameLc)) {
                        source = 'snap';
                        uninstallId = snaps.get(nameLc);
                    } else if (snaps.has(baseId.toLowerCase())) {
                        source = 'snap';
                        uninstallId = snaps.get(baseId.toLowerCase());
                    }
                }
            }

            results.push({name, iconName, source, uninstallId, desktopId: id, desktopPath});
        } catch (_) {
            continue;
        }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
}


// -- Confirm dialog ---------------------------------------------------------

const ConfirmDialog = GObject.registerClass(
class ConfirmDialog extends ModalDialog.ModalDialog {
    _init(appName, source, pkgId, onConfirm) {
        super._init({styleClass: 'app-manager-confirm-dialog'});

        const box = new St.BoxLayout({
            vertical: true,
            style: 'spacing:12px; padding:20px; min-width:300px;',
        });
        this.contentLayout.add_child(box);

        box.add_child(new St.Label({
            text: `Uninstall "${appName}"?`,
            style: 'font-size:16px; font-weight:bold; text-align:center;',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: `Source: ${source.toUpperCase()}\nPackage: ${pkgId}\n\nYour password will be required.`,
            style: 'font-size:13px; text-align:center; color:#aaa;',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        this.setButtons([
            {label: 'Cancel', action: () => this.close(), key: Clutter.KEY_Escape},
            {label: 'Uninstall', action: () => { this.close(); onConfirm(); }, default: true},
        ]);
    }
});


// -- Application window -----------------------------------------------------

const AppWindow = GObject.registerClass({
    Signals: {'closed': {}},
}, class AppWindow extends St.BoxLayout {

    _init() {
        super._init({
            vertical: true, visible: false, reactive: true,
            style_class: 'app-manager-window',
        });
        this._apps = [];
        this._filter = 'all';
        this._search = '';
        this._cancellable = null;
        this._buildUI();
    }

    _buildUI() {
        const header = new St.BoxLayout({style_class: 'app-manager-header'});
        this.add_child(header);
        header.add_child(new St.Icon({
            icon_name: 'view-grid-symbolic', icon_size: 22,
            style: 'margin-right:10px;',
        }));
        header.add_child(new St.Label({
            text: 'Applications', style_class: 'app-manager-title',
            y_align: Clutter.ActorAlign.CENTER, x_expand: true,
        }));
        const close = new St.Button({
            style_class: 'app-manager-close-btn',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
        });
        close.connect('clicked', () => this.close());
        header.add_child(close);

        this._entry = new St.Entry({
            hint_text: '  Search applications…',
            style_class: 'app-manager-search', can_focus: true,
        });
        this._entry.get_clutter_text().connect('text-changed', () => {
            this._search = this._entry.get_text();
            this._fill();
        });
        this.add_child(this._entry);

        const bar = new St.BoxLayout({style_class: 'app-manager-filters'});
        this.add_child(bar);
        this._btns = {};
        for (const {key, label} of [
            {key: 'all', label: 'All'}, {key: 'deb', label: 'Deb'},
            {key: 'flatpak', label: 'Flatpak'}, {key: 'snap', label: 'Snap'},
        ]) {
            const b = new St.Button({
                label, style_class: 'app-manager-filter-btn', toggle_mode: true,
            });
            if (key === 'all') b.checked = true;
            b.connect('clicked', () => {
                this._filter = key;
                Object.entries(this._btns).forEach(([k, v]) => { v.checked = k === key; });
                this._fill();
            });
            bar.add_child(b);
            this._btns[key] = b;
        }

        this._count = new St.Label({text: '', style_class: 'app-manager-count'});
        this.add_child(this._count);

        const scroll = new St.ScrollView({
            style_class: 'app-manager-scroll',
            overlay_scrollbars: true, x_expand: true, y_expand: true,
        });
        this.add_child(scroll);
        this._list = new St.BoxLayout({
            vertical: true, style_class: 'app-manager-list', x_expand: true,
        });
        scroll.set_child(this._list);
    }

    open() {
        this.show();
        this._entry.set_text('');
        this._filter = 'all';
        Object.entries(this._btns).forEach(([k, b]) => { b.checked = k === 'all'; });
        this._count.text = 'Loading…';
        this._list.destroy_all_children();

        const mon = Main.layoutManager.primaryMonitor;
        const pH = Main.panel.get_height();
        const w = 460, h = Math.min(mon.height - pH - 40, 700);
        this.set_size(w, h);
        this.set_position(mon.x + mon.width - w - 12, mon.y + pH + 6);

        // Cancel any in-flight load (e.g. user closed and reopened quickly).
        this._cancelLoad();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        _collectApps(cancellable).then(apps => {
            // Bail if this load was cancelled or superseded by another open().
            if (cancellable.is_cancelled() || this._cancellable !== cancellable)
                return;
            this._cancellable = null;
            this._apps = apps;
            this._fill();
            global.stage.set_key_focus(this._entry);
        }).catch(() => { /* swallow — cancellation or unexpected */ });
    }

    close() {
        this._cancelLoad();
        this.hide();
        this.emit('closed');
    }

    _cancelLoad() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    _fill() {
        this._list.destroy_all_children();
        const q = this._search.toLowerCase();
        let n = 0;
        for (const app of this._apps) {
            if (this._filter !== 'all' && app.source !== this._filter) continue;
            if (q && !app.name.toLowerCase().includes(q)) continue;
            this._list.add_child(this._row(app));
            n++;
        }
        this._count.text = `${n} application${n !== 1 ? 's' : ''}`;
    }

    _row(d) {
        const row = new St.BoxLayout({
            style_class: 'app-manager-row',
            reactive: true, track_hover: true, x_expand: true,
        });
        row.add_child(new St.Icon({
            icon_name: d.iconName, icon_size: 32,
            style_class: 'app-manager-icon',
            fallback_icon_name: 'application-x-executable',
        }));

        const col = new St.BoxLayout({vertical: true, x_expand: true, style: 'spacing:3px;'});
        col.add_child(new St.Label({
            text: d.name, style_class: 'app-manager-app-name',
            x_align: Clutter.ActorAlign.START,
        }));
        col.add_child(new St.Label({
            text: d.source.toUpperCase(),
            style_class: `app-manager-badge app-manager-badge-${d.source}`,
            x_align: Clutter.ActorAlign.START,
        }));
        row.add_child(col);

        const btn = new St.Button({
            style_class: 'app-manager-uninstall-btn',
            child: new St.Icon({icon_name: 'user-trash-symbolic', icon_size: 16}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.connect('clicked', () => {
            this.close();
            new ConfirmDialog(d.name, d.source, d.uninstallId, () => {
                this._uninstall(d).catch(() => { /* ignore */ });
            }).open(global.get_current_time());
        });
        row.add_child(btn);
        return row;
    }

    async _uninstall(d) {
        let argv;
        switch (d.source) {
        case 'flatpak':
            argv = ['flatpak', 'uninstall', '--noninteractive', '-y', d.uninstallId];
            break;
        case 'snap':
            // pkexec is required per EGO guidelines for privileged subprocesses
            argv = ['pkexec', 'snap', 'remove', d.uninstallId];
            break;
        case 'deb': {
            let pkg = d.uninstallId;
            if (d.desktopPath) {
                const resolved = await _debPkgForDesktop(d.desktopPath);
                if (resolved) pkg = resolved;
            }
            if (await _isProtectedDeb(pkg)) {
                Main.notify('App Manager Remover',
                    `${d.name} is a protected system package.`);
                return;
            }
            // pkexec is required per EGO guidelines for privileged subprocesses
            argv = ['pkexec', 'apt', 'remove', '-y', pkg];
            break;
        }
        default: return;
        }
        Main.notify('App Manager Remover', `Uninstalling ${d.name}…`);
        _spawnDetached(argv);
    }

    vfunc_key_press_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});


// -- Backdrop ---------------------------------------------------------------

const Backdrop = GObject.registerClass(
class Backdrop extends St.Widget {
    _init(win) {
        super._init({reactive: true, visible: false});
        this._win = win;
    }
    vfunc_button_press_event() {
        this._win.close();
        return Clutter.EVENT_STOP;
    }
});


// -- Panel button -----------------------------------------------------------

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(win, bk) {
        super._init(0.0, 'App Manager Remover', true);
        this._win = win;
        this._bk = bk;
        this.add_child(new St.Icon({
            icon_name: 'view-grid-symbolic', style_class: 'system-status-icon',
        }));
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS ||
            event.type() === Clutter.EventType.TOUCH_BEGIN) {
            this._toggle();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _toggle() {
        if (this._win.visible) {
            this._win.close();
        } else {
            const m = Main.layoutManager.primaryMonitor;
            this._bk.set_position(m.x, m.y + Main.panel.get_height());
            this._bk.set_size(m.width, m.height);
            this._bk.show();
            this._win.open();
        }
    }
});


// -- Extension lifecycle ----------------------------------------------------

export default class AppManagerRemoverExtension extends Extension {

    enable() {
        this._win = new AppWindow();
        this._bk = new Backdrop(this._win);

        this._closedId = this._win.connect('closed', () => this._bk.hide());

        Main.layoutManager.addTopChrome(this._bk);
        Main.layoutManager.addTopChrome(this._win);

        this._indicator = new Indicator(this._win, this._bk);
        Main.panel.addToStatusArea('app-manager-remover', this._indicator);
    }

    disable() {
        if (this._closedId) {
            this._win.disconnect(this._closedId);
            this._closedId = 0;
        }

        // Cancel any in-flight subprocess listing.
        this._win._cancelLoad();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
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
    }
}
