import {NetBirdProfileClient} from './netbirdProfiles.js';


const DEFAULT_TIMEOUT_MS = 5000;


export async function loadNetBirdProfiles({
    cancellable = null,
    socketPath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const client = createProfileClient({socketPath, timeoutMs});
    const activeProfile = await client.getActiveProfileAsync({cancellable, timeoutMs});
    const profiles = await client.listProfilesAsync(activeProfile.username, {
        cancellable,
        timeoutMs,
    });

    return profiles.map(profile => ({
        ...profile,
        selected: profile.selected || profile.name === activeProfile.profileName,
        username: activeProfile.username,
    }));
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

function createProfileClient({socketPath, timeoutMs}) {
    return new NetBirdProfileClient({
        socketPath,
        timeoutMs,
    });
}
