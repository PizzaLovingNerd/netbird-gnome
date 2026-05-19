import {DEFAULT_TIMEOUT_MS, NetBirdCliError, runNetBird} from './command.js';


export async function netbird_status({
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    try {
        const result = await runNetBird(['status', '--json'], {cancellable, timeoutMs});
        return {
            ...result,
            ...parseStatus(result.stdout),
        };
    } catch (error) {
        if (error instanceof NetBirdCliError && error.stdout) {
            return {
                ...error.result,
                ...parseStatus(error.stdout),
            };
        }

        throw error;
    }
}

export function parseStatusText(output) {
    const match = output.match(/(?:daemon\s+status|status)\s*:\s*([^\n]+)/i);
    return match?.[1]?.trim() ?? '';
}

function parseStatus(output) {
    const trimmed = output.trim();
    const jsonText = extractJsonObject(trimmed);
    let details = null;

    if (jsonText) {
        try {
            details = JSON.parse(jsonText);
        } catch {
            details = null;
        }
    }

    const status = normalizeStatus(details) || parseStatusText(trimmed);
    const connected = normalizeConnected(details, status);
    const profileName = normalizeProfileName(details);

    return {
        connected,
        details,
        profileName,
        status,
    };
}

function extractJsonObject(output) {
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');

    if (start === -1 || end === -1 || end < start)
        return '';

    return output.slice(start, end + 1);
}

function normalizeStatus(value) {
    if (typeof value === 'string')
        return value;

    if (!value || typeof value !== 'object')
        return '';

    const candidates = [
        value.daemonStatus,
        value.DaemonStatus,
        value.daemon_status,
        value.status,
        value.Status,
        value.connectionStatus,
        value.ConnectionStatus,
        value.state,
        value.State,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate)
            return candidate;
    }

    return '';
}

function normalizeProfileName(value) {
    if (!value || typeof value !== 'object')
        return '';

    const candidates = [
        value.profileName,
        value.ProfileName,
        value.profile_name,
        value.activeProfile,
        value.ActiveProfile,
        value.activeProfileName,
        value.ActiveProfileName,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate)
            return candidate;
    }

    return '';
}

function normalizeConnected(details, status) {
    if (isConnectedStatus(status))
        return true;

    if (isDisconnectedStatus(status))
        return false;

    if (isPendingStatus(status))
        return false;

    const connected = findConnectedBoolean(details);
    if (connected !== null)
        return connected;

    return false;
}

function findConnectedBoolean(value) {
    if (!value || typeof value !== 'object')
        return null;

    const candidates = [
        value.connected,
        value.Connected,
        value.isConnected,
        value.IsConnected,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'boolean')
            return candidate;
    }

    const containers = [
        value.management,
        value.Management,
        value.managementState,
        value.ManagementState,
        value.signal,
        value.Signal,
        value.signalState,
        value.SignalState,
    ];

    const connectedStates = containers
        .map(container => findConnectedBoolean(container))
        .filter(state => state !== null);

    if (connectedStates.length > 0)
        return connectedStates.every(Boolean);

    return null;
}

function isConnectedStatus(status) {
    return status.toLowerCase() === 'connected';
}

function isDisconnectedStatus(status) {
    return [
        'disconnected',
        'down',
        'idle',
        'loginfailed',
        'needslogin',
        'sessionexpired',
    ].includes(status.toLowerCase());
}

function isPendingStatus(status) {
    return status.toLowerCase() === 'connecting';
}
