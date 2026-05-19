import Gio from 'gi://Gio';

import {DEFAULT_TIMEOUT_MS, runNetBird} from './command.js';
import {parseStatusText} from './status.js';


export async function netbird_up({
    cancellable = null,
    extraArgs = [],
    onLoginUrlOpen = null,
    openLoginUrl = true,
    profileName = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const args = ['up'];
    if (profileName)
        args.push('--profile', profileName);

    args.push(...extraArgs);

    let loginUrl = '';
    let loginUrlOpened = false;
    const handleOutput = chunk => {
        if (loginUrl)
            return;

        loginUrl = extractLoginUrl(chunk);
        if (loginUrl)
            onLoginUrlOpen?.(loginUrl);

        if (loginUrl && openLoginUrl) {
            launchLoginUrl(loginUrl);
            loginUrlOpened = true;
        }
    };

    let result;
    try {
        result = await runNetBird(args, {
            cancellable,
            onStderr: handleOutput,
            onStdout: handleOutput,
            timeoutMs,
        });
    } catch (error) {
        loginUrl ||= extractLoginUrl(`${error.stdout ?? ''}\n${error.stderr ?? ''}`);
        if (!loginUrl)
            throw error;

        if (!loginUrlOpened)
            onLoginUrlOpen?.(loginUrl);

        if (openLoginUrl && !loginUrlOpened) {
            launchLoginUrl(loginUrl);
        }

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
        status: parseStatusText(result.stdout) || 'connected',
    };
}

function extractLoginUrl(output) {
    const match = output.match(/\bhttps?:\/\/[^\s<>"')]+/);
    return match?.[0]?.replace(/[.,;:]+$/, '') ?? '';
}

function launchLoginUrl(loginUrl) {
    try {
        Gio.AppInfo.launch_default_for_uri(loginUrl, null);
        console.log(`NetBird CLI login URL opened in browser: ${loginUrl}`);
    } catch (error) {
        console.warn(`Failed to open NetBird login URL: ${error}`);
    }
}
