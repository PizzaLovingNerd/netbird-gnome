import {DEFAULT_TIMEOUT_MS, runNetBird} from './command.js';


export async function netbird_down({
    cancellable = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const result = await runNetBird(['down'], {cancellable, timeoutMs});
    return {
        ...result,
        status: 'disconnected',
    };
}
