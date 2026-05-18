import GLib from 'gi://GLib';

import {NetBirdProfileClient} from './netbirdProfiles.js';


const DEFAULT_TIMEOUT_MS = 5000;


export async function loadNetBirdProfiles({
    cancellable = null,
    socketPath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    username = getCurrentUsername(),
} = {}) {
    const client = createProfileClient({socketPath, timeoutMs});
    return (await client.getProfilesAsync(username, {cancellable, timeoutMs})).profiles;
}

export async function getActiveNetBirdProfile({
    cancellable = null,
    socketPath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const client = createProfileClient({socketPath, timeoutMs});
    return await client.getActiveProfileAsync({cancellable, timeoutMs});
}

export async function switchNetBirdProfile(profileName, {
    cancellable = null,
    socketPath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    username = '',
} = {}) {
    const client = createProfileClient({socketPath, timeoutMs});
    await client.switchProfileAsync(profileName, username, {cancellable, timeoutMs});
}

export async function connectNetBird({
    cancellable = null,
    profileName = '',
    socketPath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    username = '',
} = {}) {
    const client = createProfileClient({socketPath, timeoutMs});
    await client.upAsync(profileName, username, {cancellable, timeoutMs});
}

export async function disconnectNetBird({
    cancellable = null,
    socketPath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const client = createProfileClient({socketPath, timeoutMs});
    await client.downAsync({cancellable, timeoutMs});
}

export async function getNetBirdStatus({
    cancellable = null,
    socketPath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    waitForReady = false,
} = {}) {
    const client = createProfileClient({socketPath, timeoutMs});
    return await client.statusAsync({cancellable, timeoutMs, waitForReady});
}

export async function loginNetBird({
    cancellable = null,
    hostname = undefined,
    profileName = '',
    socketPath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    username = getCurrentUsername(),
} = {}) {
    const client = createProfileClient({socketPath, timeoutMs});
    return await client.loginAsync({
        cancellable,
        hostname,
        profileName,
        timeoutMs,
        username,
    });
}

export async function waitForNetBirdLogin(userCode, {
    cancellable = null,
    hostname = undefined,
    socketPath = null,
    timeoutMs = undefined,
} = {}) {
    const client = createProfileClient({socketPath, timeoutMs});
    return await client.waitSSOLoginAsync(userCode, {cancellable, hostname, timeoutMs});
}

function createProfileClient({socketPath, timeoutMs}) {
    return new NetBirdProfileClient({
        socketPath,
        timeoutMs,
    });
}

export function getCurrentUsername() {
    return GLib.get_user_name();
}
