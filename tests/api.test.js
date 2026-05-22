import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    netbird_deregister,
    netbird_down,
    netbird_profile_add,
    netbird_profile_list,
    netbird_profile_remove,
    netbird_profile_select,
    netbird_status,
    netbird_up,
    runNetBird,
} from '../api/index.js';


const TEST_TIMEOUT_MS = 1000;

const tests = [
    ['runNetBird', () => runNetBird(['status', '--json'], {timeoutMs: TEST_TIMEOUT_MS})],
    ['runNetBird with cancellable', () =>
        runNetBird(['status', '--json'], withCancellable())],
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
];


async function main() {
    const fakeCli = GLib.build_filenamev([
        GLib.get_current_dir(),
        'tests',
        'fixtures',
        'fake-netbird',
    ]);
    GLib.setenv('NETBIRD_CLI', fakeCli, true);

    for (const [name, test] of tests)
        await assertDoesNotThrow(name, test);
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
    try {
        const status = await netbird_status({timeoutMs: TEST_TIMEOUT_MS});
        if (status.profileName !== expected)
            throw new Error(`expected profileName=${expected}, got ${status.profileName}`);
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

await main();
