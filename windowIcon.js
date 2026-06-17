import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';


export const NETBIRD_APPLICATION_ID = 'io.netbird.gnome';
export const NETBIRD_APPLICATION_NAME = 'NetBird for GNOME';
export const NETBIRD_ICON_NAME = 'netbird';
const NETBIRD_DESKTOP_FILE_NAME = `${NETBIRD_APPLICATION_ID}.desktop`;


export function configureNetBirdApplicationIdentity() {
    GLib.set_application_name(NETBIRD_APPLICATION_NAME);
    GLib.set_prgname(NETBIRD_APPLICATION_ID);
    ensureNetBirdDesktopFile();
}

export function registerNetBirdIcon() {
    configureNetBirdApplicationIdentity();

    const extensionDir = getExtensionDir();
    if (!extensionDir)
        return;

    const display = Gdk.Display.get_default();
    if (!display)
        return;

    Gtk.IconTheme
        .get_for_display(display)
        .add_search_path(GLib.build_filenamev([extensionDir, 'icons']));
    Gtk.Window.set_default_icon_name(NETBIRD_ICON_NAME);
}

export function setNetBirdWindowIcon(window) {
    if (typeof window.set_icon_name === 'function') {
        window.set_icon_name(NETBIRD_ICON_NAME);
        return;
    }

    if ('icon_name' in window)
        window.icon_name = NETBIRD_ICON_NAME;
}

function getExtensionDir() {
    const extensionDir = GLib.getenv('NETBIRD_GNOME_EXTENSION_DIR');
    if (extensionDir)
        return extensionDir;

    const file = Gio.File.new_for_uri(import.meta.url);
    return file.get_parent()?.get_path() ?? '';
}

function ensureNetBirdDesktopFile() {
    const extensionDir = getExtensionDir();
    if (!extensionDir)
        return;

    const desktopDir = GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'applications',
    ]);
    const desktopPath = GLib.build_filenamev([desktopDir, NETBIRD_DESKTOP_FILE_NAME]);
    const gjs = GLib.find_program_in_path('gjs') ?? 'gjs';
    const settingsWindow = GLib.build_filenamev([extensionDir, 'settings-window.js']);
    const iconPath = GLib.build_filenamev([extensionDir, 'icons', 'netbird.svg']);
    const contents = [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${NETBIRD_APPLICATION_NAME}`,
        'Comment=NetBird Quick Setting for GNOME',
        `Exec=${GLib.shell_quote(gjs)} -m ${GLib.shell_quote(settingsWindow)}`,
        `Icon=${iconPath}`,
        'NoDisplay=true',
        'StartupNotify=false',
        'Categories=Network;GNOME;GTK;',
        '',
    ].join('\n');

    try {
        GLib.mkdir_with_parents(desktopDir, 0o755);
        GLib.file_set_contents(desktopPath, contents);
    } catch (error) {
        console.warn(`Failed to write NetBird desktop entry: ${error}`);
    }
}
