import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


export function formatErrorMessage(error) {
    const output = [
        error?.message,
        error?.stdout,
        error?.stderr,
    ].filter(Boolean).join('\n').trim();

    if (!output)
        return String(error);

    const firstUsefulLine = output
        .split('\n')
        .map(line => line.trim())
        .find(line => line && !line.includes('caller_not_available')) ?? output;

    return firstUsefulLine.length > 240
        ? `${firstUsefulLine.slice(0, 237)}...`
        : firstUsefulLine;
}

export function isCancellation(error, cancellable) {
    if (cancellable?.is_cancelled())
        return true;

    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}
