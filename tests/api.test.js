import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    netbird_daemon_update,
    netbird_daemon_update_result,
    netbird_deregister,
    netbird_debug_bundle,
    netbird_down,
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
];


async function main() {
    const server = new FakeNetBirdJsonServer();
    server.start();
    GLib.setenv('NETBIRD_JSON_SOCKET', `tcp://127.0.0.1:${server.port}`, true);

    try {
        for (const [name, test] of tests)
            await assertDoesNotThrow(name, test);
    } finally {
        server.stop();
        GLib.unsetenv('NETBIRD_JSON_SOCKET');
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

class FakeNetBirdJsonServer {
    constructor() {
        this._service = new Gio.SocketService();
        this._service.connect('incoming', (_service, connection) => {
            void this._handleConnection(connection);
            return true;
        });
        this.port = 0;
    }

    start() {
        this.port = this._service.add_any_inet_port(null);
        this._service.start();
    }

    stop() {
        this._service.stop();
        this._service.close();
    }

    async _handleConnection(connection) {
        try {
            const request = await readHttpRequest(connection.get_input_stream());
            const response = this._dispatch(request);
            await writeHttpResponse(connection.get_output_stream(), response);
        } finally {
            connection.close(null);
        }
    }

    _dispatch(request) {
        const method = request.path.split('/').pop();

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

            return {
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
            'SetConfig',
            'SwitchProfile',
            'TriggerUpdate',
            'Up',
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
    statusCode,
}) {
    const responseBody = JSON.stringify(body);
    const reason = statusCode === 200 ? 'OK' : 'Error';
    const headers = [
        `HTTP/1.1 ${statusCode} ${reason}`,
        'Content-Type: application/json',
        'Connection: close',
    ];
    let wireBody = responseBody;

    if (chunked) {
        headers.push('Transfer-Encoding: chunked');
        wireBody = `${responseBody.length.toString(16)}\r\n${responseBody}\r\n0\r\n\r\n`;
    } else {
        headers.push(`Content-Length: ${new TextEncoder().encode(responseBody).length}`);
    }

    const response = `${headers.join('\r\n')}\r\n\r\n${wireBody}`;

    return new Promise((resolve, reject) => {
        stream.write_all_async(
            new TextEncoder().encode(response),
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                try {
                    source.write_all_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

await main();
