import GLib from 'gi://GLib';

import {
    isPathUserWritable,
    isPermissionError,
    isPrivilegedBackendInstalled,
    readJsonFilePrivileged,
    writeJsonFilePrivileged,
} from './privilegedConfig.js';


export const NETBIRD_STATE_DIRS = ['/var/lib/netbird', '/etc/netbird'];
const NETBIRD_STATE_DIR = NETBIRD_STATE_DIRS[0];
const NETBIRD_USER_CONFIG_DIR = 'netbird';
const ACTIVE_PROFILE_FILENAME = 'active_profile.txt';
const SERVICE_PARAMS_FILENAME = 'service.json';
export const MASKED_PRESHARED_KEY = '**********';

export function getActiveProfileName() {
    const statePath = GLib.build_filenamev([
        GLib.get_user_config_dir(),
        NETBIRD_USER_CONFIG_DIR,
        ACTIVE_PROFILE_FILENAME,
    ]);

    try {
        const [ok, contents] = GLib.file_get_contents(statePath);
        if (!ok)
            return 'default';

        const profileName = new TextDecoder().decode(contents).trim();
        return profileName || 'default';
    } catch {
        return 'default';
    }
}

export function getActiveProfileConfigPath(profileName = getActiveProfileName()) {
    for (const stateDir of NETBIRD_STATE_DIRS) {
        const path = getProfileConfigPathInStateDir(stateDir, profileName);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }

    return getProfileConfigPathInStateDir(NETBIRD_STATE_DIR, profileName);
}

function getProfileConfigPathInStateDir(stateDir, profileName) {
    if (profileName === 'default')
        return GLib.build_filenamev([stateDir, 'default.json']);

    const username = GLib.getenv('USER') || GLib.getenv('LOGNAME') || '';
    if (!username)
        throw new Error('Unable to resolve the current username for NetBird profile config');

    const safeUsername = sanitizeProfileName(username);
    return GLib.build_filenamev([
        stateDir,
        safeUsername,
        `${sanitizeProfileName(profileName)}.json`,
    ]);
}

export function getServiceParamsPath() {
    for (const stateDir of NETBIRD_STATE_DIRS) {
        const path = GLib.build_filenamev([stateDir, SERVICE_PARAMS_FILENAME]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }

    return GLib.build_filenamev([NETBIRD_STATE_DIR, SERVICE_PARAMS_FILENAME]);
}

export function readProfileConfig(profileName = getActiveProfileName()) {
    const configPath = getActiveProfileConfigPath(profileName);
    return readJsonFile(configPath);
}

export async function writeProfileConfig(profileName, config) {
    const configPath = getActiveProfileConfigPath(profileName);
    await writeJsonFile(configPath, config);
}

export function readActiveProfileConfig() {
    return readProfileConfig(getActiveProfileName());
}

export async function writeActiveProfileConfig(config) {
    await writeProfileConfig(getActiveProfileName(), config);
}

export function readServiceParams() {
    try {
        return readJsonFile(getServiceParamsPath());
    } catch (error) {
        if (String(error).includes('No such file') || String(error).includes('not found'))
            return {};

        throw error;
    }
}

export async function writeServiceParams(params) {
    await writeJsonFile(getServiceParamsPath(), params);
}

export function readUrlValue(value) {
    if (typeof value === 'string')
        return value;

    if (value && typeof value === 'object') {
        if (typeof value.String === 'string')
            return value.String;

        const scheme = value.Scheme ?? 'https';
        const host = value.Host ?? '';
        if (host)
            return `${scheme}://${host}${value.Path ?? ''}`;
    }

    return '';
}

export function writeUrlValue(urlString) {
    return urlString;
}

export function readBoolPtr(config, key, defaultValue = false) {
    if (!Object.hasOwn(config, key) || config[key] === null)
        return defaultValue;

    return Boolean(config[key]);
}

export function writeBoolPtr(config, key, value) {
    config[key] = Boolean(value);
}

function sanitizeProfileName(name) {
    return String(name).replace(/[^A-Za-z0-9_-]/g, '');
}

function readJsonFile(path) {
    if (shouldUsePrivilegedAccess(path))
        return readJsonFilePrivileged(path);

    try {
        return readJsonFileDirect(path);
    } catch (error) {
        if (!isPermissionError(error) || !isPrivilegedBackendInstalled())
            throw error;

        return readJsonFilePrivileged(path);
    }
}

async function writeJsonFile(path, data) {
    if (shouldUsePrivilegedAccess(path)) {
        await writeJsonFilePrivileged(path, data);
        return;
    }

    try {
        writeJsonFileDirect(path, data);
    } catch (error) {
        if (!isPermissionError(error) || !isPrivilegedBackendInstalled())
            throw error;

        await writeJsonFilePrivileged(path, data);
    }
}

function shouldUsePrivilegedAccess(path) {
    return isPrivilegedBackendInstalled() && !isPathUserWritable(path);
}

function readJsonFileDirect(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            throw new Error(`NetBird config not found: ${path}`);

        return JSON.parse(new TextDecoder().decode(contents));
    } catch (error) {
        if (isPermissionError(error))
            throw error;

        throw new Error(`NetBird config not found: ${path}`);
    }
}

function writeJsonFileDirect(path, data) {
    const json = `${JSON.stringify(data, null, 2)}\n`;
    const bytes = new TextEncoder().encode(json);

    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);

    const replaced = GLib.file_set_contents(path, bytes);
    if (!replaced)
        throw new Error(`Failed to write NetBird config: ${path}`);
}
