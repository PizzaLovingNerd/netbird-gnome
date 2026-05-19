import {DEFAULT_TIMEOUT_MS, runNetBird} from './command.js';


const PROFILE_ACTIVE_MARKERS = new Set(['✓', '✔', '*', '+']);
const PROFILE_INACTIVE_MARKERS = new Set(['✗', '✘', '-', 'x', 'X']);


export async function netbird_profile_list({
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const result = await runNetBird(['profile', 'list'], {cancellable, timeoutMs});
    const profiles = parseProfileList(result.stdout);

    return {
        ...result,
        activeProfile: profiles.find(profile => profile.selected)?.name ?? '',
        profiles,
    };
}

export async function netbird_profile_add(profileName, {
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    assertProfileName(profileName);

    const result = await runNetBird(['profile', 'add', profileName], {cancellable, timeoutMs});
    return {
        ...result,
        profile: parseProfileCommandProfile(result.stdout) || profileName,
    };
}

export async function netbird_profile_remove(profileName, {
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    assertProfileName(profileName);

    const result = await runNetBird(['profile', 'remove', profileName], {cancellable, timeoutMs});
    return {
        ...result,
        profile: parseProfileCommandProfile(result.stdout) || profileName,
    };
}

export async function netbird_profile_select(profileName, {
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    assertProfileName(profileName);

    const result = await runNetBird(['profile', 'select', profileName], {cancellable, timeoutMs});
    return {
        ...result,
        activeProfile: parseProfileCommandProfile(result.stdout) || profileName,
    };
}

function parseProfileList(output) {
    return output
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.toLowerCase().startsWith('found '))
        .map(line => {
            const [marker, ...nameParts] = line.split(/\s+/);
            const markerIsState = PROFILE_ACTIVE_MARKERS.has(marker) ||
                PROFILE_INACTIVE_MARKERS.has(marker);
            if (!markerIsState)
                return null;

            const name = nameParts.join(' ');

            if (!name)
                return null;

            return {
                name,
                selected: PROFILE_ACTIVE_MARKERS.has(marker),
            };
        })
        .filter(profile => profile !== null);
}

function parseProfileCommandProfile(output) {
    const line = output.split('\n').find(value => value.includes(':'));
    if (!line)
        return '';

    return line.slice(line.indexOf(':') + 1).trim();
}

function assertProfileName(profileName) {
    if (typeof profileName !== 'string' || profileName.trim() === '')
        throw new Error('A NetBird profile name is required');
}
