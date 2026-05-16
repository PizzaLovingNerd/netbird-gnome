#!/usr/bin/env -S gjs -m

import {NetBirdProfileClient} from './netbirdProfiles.js';


function parseArgs(argv) {
    const options = {
        socketPath: null,
        timeoutMs: 5000,
        username: '',
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];

        if (arg === '--socket' && argv[index + 1]) {
            options.socketPath = argv[++index];
        } else if (arg === '--timeout-ms' && argv[index + 1]) {
            options.timeoutMs = Number(argv[++index]);
        } else if (arg === '--username' && argv[index + 1]) {
            options.username = argv[++index];
        } else if (arg === '--help' || arg === '-h') {
            printUsage();
            imports.system.exit(0);
        } else {
            printerr(`Unknown argument: ${arg}`);
            printUsage();
            imports.system.exit(2);
        }
    }

    return options;
}

function printUsage() {
    print(`Usage: gjs -m ./testListProfiles.js [--socket PATH] [--username USERNAME]

Calls NetBird's daemon.DaemonService/ListProfiles over the local gRPC socket.

Options:
  --socket PATH       Override the NetBird daemon socket path.
  --timeout-ms MS     Cancel the daemon request after MS milliseconds.
  --username NAME    Pass a username to ListProfiles. Defaults to empty.`);
}

async function main() {
    const options = parseArgs(ARGV);
    const client = new NetBirdProfileClient({
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs,
    });

    const activeProfile = await client.getActiveProfileAsync();
    const profiles = await client.listProfilesAsync(options.username || activeProfile.username);

    print(JSON.stringify({
        activeProfile,
        profiles,
    }, null, 2));
}

try {
    await main();
} catch (error) {
    printerr(`${error.name ?? 'Error'}: ${error.message}`);

    if (error.grpcStatus)
        printerr(`gRPC status: ${error.grpcStatus}`);

    if (error.socketPaths)
        printerr(`Tried sockets: ${error.socketPaths.join(', ')}`);

    imports.system.exit(1);
}
