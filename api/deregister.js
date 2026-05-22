import {DEFAULT_TIMEOUT_MS, runNetBird} from './command.js';


export async function netbird_deregister(profileName = '', {
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const args = ['deregister'];
    if (profileName)
        args.push('--profile', profileName);

    return runNetBird(args, {cancellable, timeoutMs});
}
