import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    netbird_daemon_update,
    netbird_daemon_update_result,
    netbird_deregister,
    netbird_debug_bundle,
    netbird_down,
    netbird_get_config,
    netbird_network_deselect,
    netbird_network_list,
    netbird_network_select,
    netbird_profile_add,
    netbird_profile_list,
    netbird_profile_remove,
    netbird_profile_select,
    netbird_set_config,
    netbird_status,
    netbird_up,
} from '../api/index.js';


const TEST_TIMEOUT_MS = 1000;

const tests = [
    ['netbird_up', () => netbird_up({profileName: 'default', timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_up with cancellable', () =>
        netbird_up({...withCancellable(), profileName: 'default'})],
    ['netbird_up login URL', async () => {
        let notifiedLoginUrl = '';
        GLib.setenv('NETBIRD_FAKE_LOGIN', '1', true);
        try {
            await netbird_up({
                onLoginUrlOpen: loginUrl => {
                    notifiedLoginUrl = loginUrl;
                },
                openLoginUrl: false,
                profileName: 'default',
                timeoutMs: 100,
            });
        } finally {
            GLib.unsetenv('NETBIRD_FAKE_LOGIN');
        }

        if (!notifiedLoginUrl)
            throw new Error('expected login URL notification callback');
    }],
    ['netbird_deregister', () => netbird_deregister('default', {timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_deregister with cancellable', () =>
        netbird_deregister('default', withCancellable())],
    ['netbird_debug_bundle', () => netbird_debug_bundle({timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_debug_bundle with cancellable', () =>
        netbird_debug_bundle(withCancellable())],
    ['netbird_daemon_update', () => netbird_daemon_update({timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_daemon_update with cancellable', () =>
        netbird_daemon_update(withCancellable())],
    ['netbird_daemon_update_result', () =>
        netbird_daemon_update_result({timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_daemon_update_result with cancellable', () =>
        netbird_daemon_update_result(withCancellable())],
    ['netbird_down', () => netbird_down({timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_down with cancellable', () => netbird_down(withCancellable())],
    ['netbird_get_config', async () => {
        const result = await netbird_get_config('Work Profile', {
            timeoutMs: TEST_TIMEOUT_MS,
        });
        if (result.config.managementUrl !== 'https://api.netbird.io')
            throw new Error('expected GetConfig response');
    }],
    ['netbird_network_list', async () => {
        const result = await netbird_network_list({timeoutMs: TEST_TIMEOUT_MS});
        if (result.networks[0]?.id !== 'office')
            throw new Error('expected normalized network');
    }],
    ['netbird_network_select', () =>
        netbird_network_select(['office'], {timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_network_deselect', () =>
        netbird_network_deselect([], {all: true, timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_status', () => netbird_status({timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_status with cancellable', () => netbird_status(withCancellable())],
    ['netbird_status connected daemon state', () =>
        assertStatusConnected(
            '{"daemonStatus":"Connected","netbirdIp":"100.64.0.1/32"}',
            true)],
    ['netbird_status disconnected daemon state', () =>
        assertStatusConnected(
            '{"daemonStatus":"Idle","netbirdIp":""}',
            false)],
    ['netbird_status connecting daemon state', () =>
        assertStatusConnected(
            '{"daemonStatus":"Connecting","netbirdIp":""}',
            false)],
    ['netbird_status structured connection state', () =>
        assertStatusConnected(
            '{"management":{"connected":true},"signal":{"connected":true},"netbirdIp":"100.64.0.1/32"}',
            true)],
    ['netbird_status profile name', () =>
        assertStatusProfileName(
            '{"daemonStatus":"Connected","profileName":"Work Profile"}',
            'Work Profile')],
    ['netbird_status daemon version', () =>
        assertStatusDaemonVersion(
            '{"daemonStatus":"Connected","daemonVersion":"0.72.3"}',
            '0.72.3')],
    ['netbird_status update available', () =>
        assertStatusUpdateAvailable(
            '{"daemonStatus":"Idle","updateAvailable":true}',
            true)],
    ['netbird_profile_list', () => netbird_profile_list({timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_profile_list with cancellable', () => netbird_profile_list(withCancellable())],
    ['netbird_profile_add', () => netbird_profile_add('Test Profile', {timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_profile_add with cancellable', () =>
        netbird_profile_add('Test Profile', withCancellable())],
    ['netbird_profile_remove', () => netbird_profile_remove('Test Profile', {timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_profile_remove with cancellable', () =>
        netbird_profile_remove('Test Profile', withCancellable())],
    ['netbird_profile_select', () => netbird_profile_select('Work Profile', {timeoutMs: TEST_TIMEOUT_MS})],
    ['netbird_profile_select with cancellable', () =>
        netbird_profile_select('Work Profile', withCancellable())],
    ['netbird_set_config', () =>
        netbird_set_config({
            profileName: 'Work Profile',
            disableAutoConnect: true,
        }, {timeoutMs: TEST_TIMEOUT_MS})],
    ['chunked response on keep-alive connection', () =>
        withResponseMode('keep-alive', () =>
            netbird_status({timeoutMs: TEST_TIMEOUT_MS}))],
    ['chunked framing takes precedence over content length', () =>
        withResponseMode('chunked-with-content-length', () =>
            netbird_status({timeoutMs: TEST_TIMEOUT_MS}))],
    ['non-JSON success body', async () => {
        const result = await withResponseMode('non-json', () =>
            netbird_debug_bundle({timeoutMs: TEST_TIMEOUT_MS}));
        if (result.data !== null)
            throw new Error('expected null data for a non-JSON response');
    }],
    ['truncated content-length response', () =>
        assertRejectsResponseMode('truncated', 'Truncated NetBird JSON API response')],
    ['malformed status line', () =>
        assertRejectsResponseMode('malformed-status', 'status line')],
    ['garbage response preamble', () =>
        assertRejectsResponseMode('garbage-preamble', 'status line')],
    ['oversized response', () =>
        assertRejectsResponseMode('oversized', 'response too large', 5000)],
    ['unframed keep-alive response times out', () =>
        assertRejectsResponseMode('unframed-keep-alive', 'timed out', 100)],
    ['strict content-length parsing', () =>
        assertRejectsResponseMode('non-decimal-content-length', 'timed out', 100)],
    ['malformed chunk size', () =>
        assertRejectsResponseMode('malformed-chunk-size', 'chunk size')],
    ['request timeout', async () => {
        try {
            await withResponseMode('timeout', () =>
                netbird_debug_bundle({timeoutMs: 100}));
        } catch (error) {
            if (!error.timedOut || error.statusText !== 'Timeout')
                throw new Error(`expected timeout metadata, got: ${error}`);
            return;
        }
        throw new Error('expected request to time out');
    }],
];


async function main() {
    const server = new FakeNetBirdJsonServer();
    server.start();
    GLib.setenv('NETBIRD_JSON_SOCKET', `tcp://127.0.0.1:${server.port}`, true);

    try {
        for (const [name, test] of tests)
            await assertDoesNotThrow(name, test);

        await assertDoesNotThrow('unix socket endpoint', testUnixSocketEndpoint);
    } finally {
        server.stop();
        GLib.unsetenv('NETBIRD_JSON_SOCKET');
    }
}

async function testUnixSocketEndpoint() {
    const socketPath = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `netbird-gnome-test-${GLib.uuid_string_random()}.sock`,
    ]);
    const server = new FakeNetBirdJsonServer();
    server.startUnix(socketPath);
    GLib.setenv('NETBIRD_JSON_SOCKET', `unix://${socketPath}`, true);

    try {
        await netbird_debug_bundle({timeoutMs: TEST_TIMEOUT_MS});
    } finally {
        server.stop();
        GLib.unlink(socketPath);
    }
}

async function assertDoesNotThrow(name, callback) {
    try {
        await callback();
        print(`ok ${name}`);
    } catch (error) {
        printerr(`not ok ${name}: ${error}`);
        throw error;
    }
}

async function assertStatusConnected(statusJson, expected) {
    GLib.setenv('NETBIRD_FAKE_STATUS_JSON', statusJson, true);
    try {
        const status = await netbird_status({timeoutMs: TEST_TIMEOUT_MS});
        if (status.connected !== expected)
            throw new Error(`expected connected=${expected}, got ${status.connected}`);
    } finally {
        GLib.unsetenv('NETBIRD_FAKE_STATUS_JSON');
    }
}

async function assertStatusProfileName(statusJson, expected) {
    GLib.setenv('NETBIRD_FAKE_STATUS_JSON', statusJson, true);
    GLib.setenv('NETBIRD_FAKE_ACTIVE_PROFILE', expected, true);
    try {
        const status = await netbird_status({timeoutMs: TEST_TIMEOUT_MS});
        if (status.profileName !== expected)
            throw new Error(`expected profileName=${expected}, got ${status.profileName}`);
    } finally {
        GLib.unsetenv('NETBIRD_FAKE_STATUS_JSON');
        GLib.unsetenv('NETBIRD_FAKE_ACTIVE_PROFILE');
    }
}

async function assertStatusDaemonVersion(statusJson, expected) {
    GLib.setenv('NETBIRD_FAKE_STATUS_JSON', statusJson, true);
    try {
        const status = await netbird_status({timeoutMs: TEST_TIMEOUT_MS});
        if (status.daemonVersion !== expected)
            throw new Error(`expected daemonVersion=${expected}, got ${status.daemonVersion}`);
    } finally {
        GLib.unsetenv('NETBIRD_FAKE_STATUS_JSON');
    }
}

async function assertStatusUpdateAvailable(statusJson, expected) {
    GLib.setenv('NETBIRD_FAKE_STATUS_JSON', statusJson, true);
    try {
        const status = await netbird_status({timeoutMs: TEST_TIMEOUT_MS});
        if (status.updateAvailable !== expected)
            throw new Error(`expected updateAvailable=${expected}, got ${status.updateAvailable}`);
    } finally {
        GLib.unsetenv('NETBIRD_FAKE_STATUS_JSON');
    }
}

function withCancellable() {
    return {
        cancellable: new Gio.Cancellable(),
        timeoutMs: TEST_TIMEOUT_MS,
    };
}

async function withResponseMode(mode, callback) {
    GLib.setenv('NETBIRD_FAKE_RESPONSE_MODE', mode, true);
    try {
        return await callback();
    } finally {
        GLib.unsetenv('NETBIRD_FAKE_RESPONSE_MODE');
    }
}

async function assertRejectsResponseMode(mode, expectedMessage, timeoutMs = TEST_TIMEOUT_MS) {
    try {
        await withResponseMode(mode, () =>
            netbird_debug_bundle({timeoutMs}));
    } catch (error) {
        if (!String(error).includes(expectedMessage))
            throw new Error(`expected "${expectedMessage}" error, got: ${error}`);
        return;
    }

    throw new Error(`expected ${mode} response to reject`);
}

class FakeNetBirdJsonServer {
    constructor() {
        this._openConnections = [];
        this._service = new Gio.SocketService();
        this._service.connect('incoming', (_service, connection) => {
            void this._handleConnection(connection).catch(error => {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.BROKEN_PIPE))
                    printerr(`fake server connection failed: ${error}`);
            });
            return true;
        });
        this.port = 0;
    }

    start() {
        this.port = this._service.add_any_inet_port(null);
        this._service.start();
    }

    startUnix(path) {
        this._service.add_address(
            Gio.UnixSocketAddress.new(path),
            Gio.SocketType.STREAM,
            Gio.SocketProtocol.DEFAULT,
            null);
        this._service.start();
    }

    stop() {
        for (const connection of this._openConnections)
            connection.close(null);
        this._openConnections.length = 0;
        this._service.stop();
        this._service.close();
    }

    async _handleConnection(connection) {
        let keepAlive = false;
        try {
            const request = await readHttpRequest(connection.get_input_stream());
            const response = this._dispatch(request);
            keepAlive = Boolean(response.keepAlive);
            if (!response.noResponse)
                await writeHttpResponse(connection.get_output_stream(), response);
        } finally {
            if (keepAlive)
                this._openConnections.push(connection);
            else
                connection.close(null);
        }
    }

    _dispatch(request) {
        const method = request.path.split('/').pop();
        const responseMode = GLib.getenv('NETBIRD_FAKE_RESPONSE_MODE');

        if (responseMode === 'timeout')
            return {keepAlive: true, noResponse: true};
        if (responseMode === 'non-json')
            return {body: 'not JSON', rawBody: true, statusCode: 200};
        if (responseMode === 'truncated') {
            return {
                body: '{}',
                contentLength: 3,
                rawBody: true,
                statusCode: 200,
            };
        }
        if (responseMode === 'malformed-status')
            return {body: '{}', rawBody: true, statusLine: 'HTTP/1.1 NOPE'};
        if (responseMode === 'garbage-preamble')
            return {body: '{}', rawBody: true, statusLine: 'garbage'};
        if (responseMode === 'oversized') {
            return {
                body: 'x'.repeat((8 * 1024 * 1024) + 1),
                rawBody: true,
                statusCode: 200,
            };
        }
        if (responseMode === 'unframed-keep-alive') {
            return {
                body: '{}',
                keepAlive: true,
                omitFraming: true,
                rawBody: true,
                statusCode: 200,
            };
        }
        if (responseMode === 'non-decimal-content-length') {
            return {
                body: '{}',
                contentLength: '0x10',
                keepAlive: true,
                rawBody: true,
                statusCode: 200,
            };
        }
        if (responseMode === 'malformed-chunk-size') {
            return {
                body: '{}',
                chunked: true,
                rawBody: true,
                rawWireBody: '-5\r\n{}\r\n0\r\n\r\n',
                statusCode: 200,
            };
        }

        if (method === 'Up' && GLib.getenv('NETBIRD_FAKE_LOGIN') === '1') {
            return {
                statusCode: 500,
                body: {
                    message: 'Please log in at https://login.example.test/device?user_code=NETBIRD',
                },
            };
        }

        if (method === 'Status') {
            const statusData = GLib.getenv('NETBIRD_FAKE_STATUS_JSON');
            if (statusData)
                return {
                    body: JSON.parse(statusData),
                    chunked: true,
                    statusCode: 200,
                };

            const response = {
                body: {
                    status: 'Connected',
                    fullStatus: {
                        localPeerState: {
                            IP: '100.64.0.1/32',
                        },
                    },
                },
                chunked: true,
                statusCode: 200,
            };
            if (responseMode === 'keep-alive')
                response.keepAlive = true;
            if (responseMode === 'chunked-with-content-length') {
                response.contentLength = 1;
                response.keepAlive = true;
            }
            return response;
        }

        if (method === 'GetActiveProfile') {
            return {
                statusCode: 200,
                body: {
                    profileName: GLib.getenv('NETBIRD_FAKE_ACTIVE_PROFILE') || 'default',
                    username: GLib.get_user_name(),
                },
            };
        }

        if (method === 'GetConfig') {
            if (request.body.profileName !== 'Work Profile')
                throw new Error(`unexpected profileName: ${request.body.profileName}`);
            if (!request.body.username)
                throw new Error('expected username');

            return {
                statusCode: 200,
                body: {
                    disableAutoConnect: false,
                    managementUrl: 'https://api.netbird.io',
                },
            };
        }

        if (method === 'ListNetworks') {
            return {
                statusCode: 200,
                body: {
                    routes: [{
                        ID: 'office',
                        range: '10.0.0.0/24',
                        resolvedIPs: {},
                        selected: true,
                    }],
                },
            };
        }

        if (method === 'ListProfiles') {
            return {
                statusCode: 200,
                body: {
                    profiles: [
                        {name: 'default', isActive: true},
                        {name: 'Work Profile', isActive: false},
                    ],
                },
            };
        }

        if ([
            'AddProfile',
            'DebugBundle',
            'Down',
            'GetInstallerResult',
            'Logout',
            'RemoveProfile',
            'SelectNetworks',
            'SetConfig',
            'SwitchProfile',
            'TriggerUpdate',
            'Up',
            'DeselectNetworks',
        ].includes(method)) {
            if (method === 'SetConfig') {
                if (request.body.profileName !== 'Work Profile')
                    throw new Error(`unexpected profileName: ${request.body.profileName}`);
                if (request.body.disableAutoConnect !== true)
                    throw new Error('expected disableAutoConnect=true');
                if (!request.body.username)
                    throw new Error('expected username');
            }

            return {
                statusCode: 200,
                body: ['GetInstallerResult', 'TriggerUpdate'].includes(method)
                    ? {success: true}
                    : {},
            };
        }

        return {
            statusCode: 404,
            body: {
                message: `unknown method: ${method}`,
            },
        };
    }
}

function readHttpRequest(stream) {
    const decoder = new TextDecoder();
    let text = '';
    let headerEnd = -1;
    let contentLength = null;

    return new Promise((resolve, reject) => {
        function readNext() {
            stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try {
                    const bytes = source.read_bytes_finish(result);
                    if (bytes.get_size() === 0) {
                        resolve(parseHttpRequest(text));
                        return;
                    }

                    text += decoder.decode(bytes.toArray());
                    if (headerEnd === -1) {
                        headerEnd = text.indexOf('\r\n\r\n');
                        if (headerEnd !== -1)
                            contentLength = parseContentLength(text.slice(0, headerEnd));
                    }

                    if (headerEnd !== -1) {
                        const body = text.slice(headerEnd + 4);
                        if (contentLength === null || new TextEncoder().encode(body).length >= contentLength) {
                            resolve(parseHttpRequest(text));
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

function parseHttpRequest(text) {
    const headerEnd = text.indexOf('\r\n\r\n');
    const [requestLine] = text.slice(0, headerEnd).split('\r\n');
    const [, path] = requestLine.split(' ');
    const body = text.slice(headerEnd + 4).trim();

    return {
        body: body ? JSON.parse(body) : {},
        path,
    };
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

function writeHttpResponse(stream, {
    body,
    chunked = false,
    contentLength = null,
    omitFraming = false,
    rawBody = false,
    rawWireBody = null,
    statusCode = 200,
    statusLine = null,
}) {
    const responseBody = rawBody ? body : JSON.stringify(body);
    const responseBodyBytes = new TextEncoder().encode(responseBody);
    const reason = statusCode === 200 ? 'OK' : 'Error';
    const headers = [
        statusLine ?? `HTTP/1.1 ${statusCode} ${reason}`,
        'Content-Type: application/json',
    ];
    let wireBody = responseBody;

    if (chunked) {
        headers.push('Transfer-Encoding: chunked');
        wireBody = `${responseBodyBytes.length.toString(16)}\r\n${responseBody}\r\n0\r\n\r\n`;
    } else if (!omitFraming)
        headers.push(`Content-Length: ${contentLength ?? responseBodyBytes.length}`);

    if (chunked && contentLength !== null)
        headers.push(`Content-Length: ${contentLength}`);
    if (rawWireBody !== null)
        wireBody = rawWireBody;

    const response = `${headers.join('\r\n')}\r\n\r\n${wireBody}`;

    const encoded = new TextEncoder().encode(response);
    let offset = 0;

    return new Promise((resolve, reject) => {
        function writeNext() {
            if (offset >= encoded.length) {
                resolve();
                return;
            }

            const chunk = encoded.slice(offset, offset + 65536);
            stream.write_all_async(
                chunk,
                GLib.PRIORITY_DEFAULT,
                null,
                (source, result) => {
                    try {
                        source.write_all_finish(result);
                        offset += chunk.length;
                        writeNext();
                    } catch (error) {
                        reject(error);
                    }
                });
        }

        writeNext();
    });
}

await main();
