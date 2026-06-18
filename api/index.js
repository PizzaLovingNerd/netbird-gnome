import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


export const DEFAULT_TIMEOUT_MS = 15000;

const DEFAULT_NETBIRD_JSON_SOCKET = 'unix:///var/run/netbird-http.sock';
const DEBUG_API_OUTPUT = false;
const MIN_UNIX_SOCKET_AGE_US = 2000000;
const SERVICE_PARAMS_PATHS = [
    '/var/lib/netbird/service.json',
    '/etc/netbird/service.json',
];


export function netbird_json_api_available() {
    const endpoint = netbirdJsonSocket();

    if (endpoint.startsWith('unix://'))
        return unixSocketIsStable(endpoint.slice('unix://'.length));

    return true;
}


export async function netbird_debug_bundle({
    anonymize = false,
    cancellable = null,
    systemInfo = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    uploadURL = '',
} = {}) {
    return callNetBird('DebugBundle', {
        anonymize,
        systemInfo,
        uploadURL,
    }, {cancellable, timeoutMs});
}

export async function netbird_daemon_update({
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const result = await callNetBird('TriggerUpdate', {}, {cancellable, timeoutMs});
    const response = normalizeUpdateResponse(result.data);

    return {
        ...result,
        ...response,
    };
}

export async function netbird_daemon_update_result({
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const result = await callNetBird('GetInstallerResult', {}, {cancellable, timeoutMs});
    const response = normalizeUpdateResponse(result.data);

    return {
        ...result,
        ...response,
    };
}

export async function netbird_deregister(profileName = '', {
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const request = requestWithProfile(profileName);
    return callNetBird('Logout', request, {cancellable, timeoutMs});
}

export async function netbird_down({
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const result = await callNetBird('Down', {}, {cancellable, timeoutMs});
    return {
        ...result,
        status: 'disconnected',
    };
}

export async function netbird_profile_list({
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const result = await callNetBird('ListProfiles', {
        username: currentUsername(),
    }, {cancellable, timeoutMs});
    const profiles = parseProfileList(result.data);

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

    const result = await callNetBird('AddProfile', {
        profileName,
        username: currentUsername(),
    }, {cancellable, timeoutMs});
    return {
        ...result,
        profile: profileName,
    };
}

export async function netbird_profile_remove(profileName, {
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    assertProfileName(profileName);

    const result = await callNetBird('RemoveProfile', {
        profileName,
        username: currentUsername(),
    }, {cancellable, timeoutMs});
    return {
        ...result,
        profile: profileName,
    };
}

export async function netbird_profile_select(profileName, {
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    assertProfileName(profileName);

    const result = await callNetBird('SwitchProfile', {
        profileName,
        username: currentUsername(),
    }, {cancellable, timeoutMs});
    return {
        ...result,
        activeProfile: profileName,
    };
}

export async function netbird_set_config(config = {}, {
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const result = await callNetBird('SetConfig', {
        username: currentUsername(),
        ...config,
    }, {cancellable, timeoutMs});

    return result;
}

export async function netbird_status({
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    try {
        const result = await callNetBird('Status', {
            getFullPeerStatus: true,
            shouldRunProbes: false,
        }, {cancellable, timeoutMs});
        const activeProfile = await getActiveProfile({cancellable, timeoutMs});

        return {
            ...result,
            ...parseStatus(result.data, activeProfile),
        };
    } catch (error) {
        if (error instanceof NetBirdApiError && error.data) {
            return {
                ...error.result,
                ...parseStatus(error.data),
            };
        }

        throw error;
    }
}

export async function netbird_up({
    cancellable = null,
    onLoginUrlOpen = null,
    openLoginUrl = true,
    profileName = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    let loginUrl = '';
    let loginUrlOpened = false;

    let result;
    try {
        result = await callNetBird('Up', requestWithProfile(profileName), {cancellable, timeoutMs});
    } catch (error) {
        if (!(error instanceof NetBirdApiError))
            throw error;

        loginUrl = extractLoginUrl(`${error.body ?? ''}\n${error.message ?? ''}`);
        if (!loginUrl)
            throw error;

        if (!loginUrlOpened)
            onLoginUrlOpen?.(loginUrl);

        if (openLoginUrl && !loginUrlOpened)
            launchLoginUrl(loginUrl);

        return {
            ...error.result,
            loginUrl,
            needsLogin: true,
            status: 'login-required',
        };
    }

    return {
        ...result,
        loginUrl,
        needsLogin: Boolean(loginUrl),
        status: 'connected',
    };
}

export async function callNetBird(method, body = {}, {
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const endpoint = netbirdJsonSocket();
    const {connectable, hostHeader} = createConnectable(endpoint);
    const requestBody = JSON.stringify(body ?? {});
    const request = [
        `POST /daemon.DaemonService/${method} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Content-Type: application/json',
        'Accept: application/json',
        `Content-Length: ${new TextEncoder().encode(requestBody).length}`,
        'Connection: close',
        '',
        requestBody,
    ].join('\r\n');

    debugLog(`NetBird JSON API: ${method} ${endpoint}`);

    let timeoutId = 0;
    let cancellableHandlerId = 0;
    let timedOut = false;
    const requestCancellable = new Gio.Cancellable();

    if (cancellable) {
        if (cancellable.is_cancelled()) {
            requestCancellable.cancel();
        } else {
            cancellableHandlerId = cancellable.connect(() => {
                requestCancellable.cancel();
            });
        }
    }

    if (timeoutMs > 0) {
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timeoutId = 0;
            timedOut = true;
            requestCancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
    }

    try {
        const client = new Gio.SocketClient();
        const connection = await connectAsync(client, connectable, requestCancellable);

        try {
            await writeAllAsync(
                connection.get_output_stream(),
                new TextEncoder().encode(request),
                requestCancellable);

            const response = await readHttpResponse(
                connection.get_input_stream(),
                requestCancellable);

            const result = {
                body: response.body,
                data: parseJsonBody(response.body),
                endpoint,
                method,
                statusCode: response.statusCode,
                statusText: response.statusText,
                timedOut,
            };

            logApiOutput(method, result);

            if (response.statusCode < 200 || response.statusCode >= 300)
                throw new NetBirdApiError(result);

            return result;
        } finally {
            try {
                connection.close(null);
            } catch {
                // Ignore close failures after the response has been handled.
            }
        }
    } catch (error) {
        if (error instanceof NetBirdApiError)
            throw error;

        if (timedOut)
            throw new NetBirdApiError({
                body: `netbird JSON API timed out after ${timeoutMs}ms`,
                data: null,
                endpoint,
                method,
                statusCode: 0,
                statusText: 'Timeout',
                timedOut,
            });

        console.warn(`NetBird JSON API failed: ${method}: ${error}`);
        throw error;
    } finally {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        if (cancellable && cancellableHandlerId)
            cancellable.disconnect(cancellableHandlerId);
    }
}

export class NetBirdApiError extends Error {
    constructor(result) {
        const message = getErrorMessage(result);
        super(message);

        this.name = 'NetBirdApiError';
        this.result = result;
        this.body = result.body;
        this.data = result.data;
        this.endpoint = result.endpoint;
        this.method = result.method;
        this.statusCode = result.statusCode;
        this.statusText = result.statusText;
        this.timedOut = result.timedOut;
        this.stderr = message;
        this.stdout = result.body;
    }
}

function currentUsername() {
    return GLib.get_user_name() || GLib.getenv('USER') || '';
}

async function getActiveProfile({cancellable, timeoutMs}) {
    try {
        const result = await callNetBird('GetActiveProfile', {}, {cancellable, timeoutMs});
        return result.data?.profileName ?? '';
    } catch (error) {
        console.warn(`Failed to query NetBird active profile: ${error}`);
        return '';
    }
}

function requestWithProfile(profileName) {
    const request = {
        username: currentUsername(),
    };

    if (profileName)
        request.profileName = profileName;

    return request;
}

function parseProfileList(data) {
    return (data?.profiles ?? [])
        .map(profile => ({
            name: profile.name ?? '',
            selected: Boolean(profile.isActive ?? profile.is_active),
        }))
        .filter(profile => profile.name);
}

function assertProfileName(profileName) {
    if (typeof profileName !== 'string' || profileName.trim() === '')
        throw new Error('A NetBird profile name is required');
}

function parseStatusText(output) {
    const match = output.match(/(?:daemon\s+status|status)\s*:\s*([^\n]+)/i);
    return match?.[1]?.trim() ?? '';
}

function parseStatus(output, activeProfile = '') {
    const details = typeof output === 'string'
        ? parseStatusJsonText(output)
        : output;

    const status = normalizeStatus(details) ||
        (typeof output === 'string' ? parseStatusText(output.trim()) : '');
    const connected = normalizeConnected(details, status);
    const profileName = activeProfile || normalizeProfileName(details);

    return {
        connected,
        daemonVersion: normalizeDaemonVersion(details),
        details,
        profileName,
        status,
        updateAvailable: normalizeUpdateAvailable(details),
    };
}

function parseStatusJsonText(output) {
    const trimmed = output.trim();
    const jsonText = extractJsonObject(trimmed);
    if (!jsonText)
        return null;

    try {
        return JSON.parse(jsonText);
    } catch {
        return null;
    }
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

function normalizeDaemonVersion(value) {
    if (!value || typeof value !== 'object')
        return '';

    const candidates = [
        value.daemonVersion,
        value.DaemonVersion,
        value.daemon_version,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate)
            return candidate;
    }

    return '';
}

function normalizeUpdateAvailable(value) {
    if (!value || typeof value !== 'object')
        return false;

    const candidates = [
        value.updateAvailable,
        value.UpdateAvailable,
        value.update_available,
        value.daemonUpdateAvailable,
        value.DaemonUpdateAvailable,
        value.daemon_update_available,
        value.update,
        value.Update,
        value.hasUpdate,
        value.HasUpdate,
        value.has_update,
        value.needsUpdate,
        value.NeedsUpdate,
        value.needs_update,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'boolean')
            return candidate;

        if (typeof candidate === 'string') {
            const normalized = candidate.trim().toLowerCase();
            if (['true', 'yes', 'available', 'needed', 'required'].includes(normalized))
                return true;

            if (['false', 'no', 'none', 'unavailable'].includes(normalized))
                return false;
        }
    }

    const containers = [
        value.daemon,
        value.Daemon,
        value.client,
        value.Client,
        typeof value.update === 'object' ? value.update : null,
        typeof value.Update === 'object' ? value.Update : null,
        value.updateStatus,
        value.UpdateStatus,
        value.update_status,
        value.updateState,
        value.UpdateState,
        value.update_state,
    ];

    return containers.some(container => normalizeUpdateAvailable(container));
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

function normalizeUpdateResponse(data) {
    const success = Boolean(data?.success ?? data?.Success);
    const errorMessage = String(data?.errorMsg ?? data?.error_msg ?? data?.ErrorMsg ?? '').trim();

    return {
        errorMessage,
        message: success
            ? 'Daemon update started'
            : errorMessage || 'No daemon update was started',
        success,
    };
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

function extractLoginUrl(output) {
    const match = output.match(/\bhttps?:\/\/[^\s<>"')]+/);
    return match?.[0]?.replace(/[.,;:]+$/, '') ?? '';
}

function launchLoginUrl(loginUrl) {
    try {
        Gio.AppInfo.launch_default_for_uri(loginUrl, null);
        console.log(`NetBird login URL opened in browser: ${loginUrl}`);
    } catch (error) {
        console.warn(`Failed to open NetBird login URL: ${error}`);
    }
}

function connectAsync(client, connectable, cancellable) {
    return new Promise((resolve, reject) => {
        client.connect_async(connectable, cancellable, (source, result) => {
            try {
                resolve(source.connect_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function writeAllAsync(stream, bytes, cancellable) {
    return new Promise((resolve, reject) => {
        stream.write_all_async(bytes, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                source.write_all_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

function readHttpResponse(stream, cancellable) {
    const decoder = new TextDecoder();
    let text = '';
    let headerEnd = -1;
    let contentLength = null;

    return new Promise((resolve, reject) => {
        function readNext() {
            stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    const bytes = source.read_bytes_finish(result);
                    if (bytes.get_size() === 0) {
                        resolve(parseResponse(text));
                        return;
                    }

                    text += decoder.decode(bytes.toArray());

                    if (headerEnd === -1) {
                        headerEnd = text.indexOf('\r\n\r\n');
                        if (headerEnd !== -1)
                            contentLength = parseContentLength(text.slice(0, headerEnd));
                    }

                    if (headerEnd !== -1 && contentLength !== null) {
                        const body = text.slice(headerEnd + 4);
                        if (new TextEncoder().encode(body).length >= contentLength) {
                            resolve(parseResponse(text));
                            return;
                        }
                    }

                    readNext();
                } catch (error) {
                    reject(error);
                }
            });
        }

        readNext();
    });
}

function parseResponse(text) {
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd === -1)
        throw new Error('Invalid NetBird JSON API response');

    const headerText = text.slice(0, headerEnd);
    let body = text.slice(headerEnd + 4);
    const headers = parseHeaders(headerText);
    const [statusLine] = headerText.split('\r\n');
    const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/);

    if (!statusMatch)
        throw new Error(`Invalid NetBird JSON API status line: ${statusLine}`);

    if (headers.get('transfer-encoding')?.toLowerCase().includes('chunked'))
        body = decodeChunkedBody(body);

    return {
        body,
        statusCode: Number(statusMatch[1]),
        statusText: statusMatch[2] || '',
    };
}

function parseHeaders(headerText) {
    const headers = new Map();
    for (const line of headerText.split('\r\n').slice(1)) {
        const separator = line.indexOf(':');
        if (separator === -1)
            continue;

        headers.set(
            line.slice(0, separator).trim().toLowerCase(),
            line.slice(separator + 1).trim());
    }

    return headers;
}

function parseContentLength(headerText) {
    const line = headerText
        .split('\r\n')
        .find(value => value.toLowerCase().startsWith('content-length:'));
    if (!line)
        return null;

    const value = Number(line.slice(line.indexOf(':') + 1).trim());
    return Number.isFinite(value) ? value : null;
}

function decodeChunkedBody(body) {
    let offset = 0;
    const chunks = [];

    while (offset < body.length) {
        const lineEnd = body.indexOf('\r\n', offset);
        if (lineEnd === -1)
            break;

        const sizeText = body.slice(offset, lineEnd).split(';')[0].trim();
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size))
            break;

        offset = lineEnd + 2;
        if (size === 0)
            break;

        chunks.push(body.slice(offset, offset + size));
        offset += size + 2;
    }

    return chunks.join('');
}

function parseJsonBody(body) {
    const trimmed = body.trim();
    if (!trimmed)
        return {};

    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function createConnectable(endpoint) {
    if (endpoint.startsWith('unix://')) {
        const path = endpoint.slice('unix://'.length);
        return {
            connectable: Gio.UnixSocketAddress.new(path),
            hostHeader: 'unix',
        };
    }

    if (endpoint.startsWith('tcp://')) {
        const address = endpoint.slice('tcp://'.length);
        const [host, portText] = address.split(':');
        const port = Number(portText);
        if (!host || !Number.isInteger(port))
            throw new Error(`Invalid NetBird JSON API TCP endpoint: ${endpoint}`);

        return {
            connectable: Gio.NetworkAddress.new(host, port),
            hostHeader: address,
        };
    }

    throw new Error(`Unsupported NetBird JSON API endpoint: ${endpoint}`);
}

function netbirdJsonSocket() {
    return GLib.getenv('NETBIRD_JSON_SOCKET') ||
        readConfiguredJsonSocket() ||
        DEFAULT_NETBIRD_JSON_SOCKET;
}

function unixSocketIsStable(path) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return false;

    try {
        const info = Gio.File.new_for_path(path).query_info(
            'time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NONE,
            null);
        const modifiedUs = (info.get_attribute_uint64('time::modified') * 1000000) +
            info.get_attribute_uint32('time::modified-usec');

        return GLib.get_real_time() - modifiedUs >= MIN_UNIX_SOCKET_AGE_US;
    } catch {
        return true;
    }
}

function readConfiguredJsonSocket() {
    for (const path of SERVICE_PARAMS_PATHS) {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            continue;

        try {
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok)
                continue;

            const params = JSON.parse(new TextDecoder().decode(contents));
            if (params.disable_json_socket || params.jsonSocketDisabled)
                continue;

            const socket = params.json_socket || params.jsonSocket;
            if (typeof socket === 'string' && socket)
                return socket;
        } catch (error) {
            console.warn(`Failed to read NetBird service params from ${path}: ${error}`);
        }
    }

    return '';
}

function getErrorMessage(result) {
    const data = result.data;
    if (data && typeof data === 'object') {
        if (typeof data.message === 'string' && data.message)
            return data.message;
        if (typeof data.error === 'string' && data.error)
            return data.error;
    }

    return result.body?.trim() ||
        result.statusText ||
        `netbird JSON API failed with status ${result.statusCode}`;
}

function logApiOutput(method, result) {
    if (!DEBUG_API_OUTPUT)
        return;

    console.log(`NetBird JSON API ${method}: HTTP ${result.statusCode} ${result.statusText}`);
    if (result.body?.trim())
        console.log(`NetBird JSON API ${method} body: ${result.body.trim()}`);
}

function debugLog(message) {
    if (DEBUG_API_OUTPUT)
        console.log(message);
}
