import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {presentAlertDialog} from './profile-add-dialog.js';


export const POLKIT_POLICY_PATH = '/usr/share/polkit-1/actions/io.netbird.gnome.policy';
export const PRIVILEGED_HELPER_PATH = '/usr/libexec/netbird-gnome-config-write';

const INSTALL_SCRIPT_NAME = 'install-netbird-gnome-polkit.sh';
const EXTENSION_DIR_ENV = 'NETBIRD_GNOME_EXTENSION_DIR';
const CANCELLED_EXIT_CODES = new Set([126, 127, 255]);


export function getExtensionDir() {
    const fromEnv = GLib.getenv(EXTENSION_DIR_ENV);
    if (fromEnv)
        return fromEnv;

    const home = GLib.get_home_dir();
    const candidates = [
        GLib.build_filenamev([home, '.local', 'share', 'gnome-shell', 'extensions', 'gnome@netbird.io']),
        '/usr/share/gnome-shell/extensions/gnome@netbird.io',
    ];

    for (const candidate of candidates) {
        if (GLib.file_test(candidate, GLib.FileTest.IS_DIR))
            return candidate;
    }

    return '';
}

export function getInstallScriptPath() {
    const extensionDir = getExtensionDir();
    if (!extensionDir)
        return '';

    return GLib.build_filenamev([extensionDir, 'polkit', INSTALL_SCRIPT_NAME]);
}

export function isPrivilegedBackendInstalled() {
    return GLib.file_test(POLKIT_POLICY_PATH, GLib.FileTest.EXISTS) &&
        GLib.file_test(PRIVILEGED_HELPER_PATH, GLib.FileTest.IS_EXECUTABLE);
}

export function isPathUserWritable(path) {
    const file = Gio.File.new_for_path(path);

    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return fileHasAccess(file, 'can-write');

    const parent = file.get_parent();
    if (!parent)
        return false;

    return fileHasAccess(parent, 'can-write');
}

function fileHasAccess(file, attribute) {
    try {
        const info = file.query_info(`access::${attribute}`, Gio.FileQueryInfoFlags.NONE);
        return info.get_attribute_boolean(`access::${attribute}`);
    } catch {
        return false;
    }
}

export function needsPrivilegedAccessForPaths(paths) {
    return paths.some(path => !isPathUserWritable(path));
}

export async function ensureSaveAccessBeforeApply(parent, paths) {
    if (!needsPrivilegedAccessForPaths(paths))
        return true;

    if (isPrivilegedBackendInstalled())
        return true;

    return promptInstallPrivilegedBackend({parent});
}

export function isPermissionError(error) {
    const message = String(error ?? '');
    return message.includes('Permission denied') ||
        message.includes('permission denied') ||
        message.includes('Not permitted') ||
        message.includes('read-only file system') ||
        message.includes('Failed to open file') ||
        message.includes('Failed to write NetBird config');
}

export function readJsonFilePrivileged(path) {
    const subprocess = Gio.Subprocess.new(
        ['pkexec', PRIVILEGED_HELPER_PATH, 'read', path],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

    const [, stdout, stderr] = subprocess.communicate_utf8(null, null);
    if (!subprocess.get_successful()) {
        const exitStatus = subprocess.get_exit_status();
        if (CANCELLED_EXIT_CODES.has(exitStatus))
            throw new Error('Permission request was cancelled');

        throw new Error(stderr?.trim() || stdout?.trim() || `Failed to read NetBird config (${exitStatus})`);
    }

    return JSON.parse(stdout.trim());
}

export async function writeJsonFilePrivileged(path, data) {
    const tempPath = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `netbird-gnome-${GLib.uuid_string_random()}.json`,
    ]);
    const json = `${JSON.stringify(data, null, 2)}\n`;
    const bytes = new TextEncoder().encode(json);

    GLib.file_set_contents(tempPath, bytes);

    try {
        await runPkexec([PRIVILEGED_HELPER_PATH, 'write', path, tempPath]);
    } finally {
        try {
            GLib.unlink(tempPath);
        } catch {
            // Temp file may already be gone.
        }
    }
}

export async function installPrivilegedBackend() {
    const installScript = getInstallScriptPath();
    const extensionDir = getExtensionDir();

    if (!installScript || !extensionDir)
        throw new Error('Unable to locate the NetBird GNOME extension directory');

    await runPkexec([installScript, extensionDir]);
}

export function promptInstallPrivilegedBackend({
    parent = null,
    onInstalled = null,
} = {}) {
    return new Promise(resolve => {
        const dialog = new Adw.AlertDialog({
            heading: 'Install NetBird Permissions?',
            body: 'Saving NetBird settings requires permission to update files in /var/lib/netbird (and legacy /etc/netbird paths). Install a small PolicyKit rule so you can authenticate when you apply changes.',
            close_response: 'cancel',
            default_response: 'install',
        });

        dialog.add_response('cancel', 'Not Now');
        dialog.add_response('install', 'Install');
        dialog.set_response_appearance('install', Adw.ResponseAppearance.SUGGESTED);

        dialog.connect('response', async (_source, response) => {
            if (response !== 'install') {
                onInstalled?.(false);
                resolve(false);
                return;
            }

            try {
                await installPrivilegedBackend();
                const installed = isPrivilegedBackendInstalled();
                if (installed)
                    onInstalled?.(true);
                else
                    onInstalled?.(false, new Error('PolicyKit files were not installed'));

                resolve(installed);
            } catch (error) {
                console.warn(`Failed to install NetBird PolicyKit files: ${error}`);
                onInstalled?.(false, error);
                resolve(false);
            }
        });

        presentAlertDialog(dialog, parent);
    });
}

function runPkexec(argv) {
    return new Promise((resolve, reject) => {
        const subprocess = Gio.Subprocess.new(
            ['pkexec', ...argv],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

        subprocess.communicate_utf8_async(null, null, (_proc, result) => {
            try {
                const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                if (subprocess.get_successful()) {
                    resolve({
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                    });
                    return;
                }

                const exitStatus = subprocess.get_exit_status();
                if (CANCELLED_EXIT_CODES.has(exitStatus))
                    reject(new Error('Permission request was cancelled'));

                reject(new Error(stderr?.trim() || stdout?.trim() || `pkexec failed with status ${exitStatus}`));
            } catch (error) {
                reject(error);
            }
        });
    });
}
