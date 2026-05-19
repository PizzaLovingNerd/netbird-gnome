import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


export const DEFAULT_TIMEOUT_MS = 15000;

const DEFAULT_NETBIRD_COMMAND = 'netbird';
const DEBUG_CLI_OUTPUT = true;


export async function runNetBird(args, {
    cancellable = null,
    onStderr = null,
    onStdout = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const argv = [netbirdCommand(), ...args];
    const subprocess = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

    debugLog(`NetBird CLI: ${formatCommand(argv)}`);

    let timeoutId = 0;
    let cancellableHandlerId = 0;
    let timedOut = false;
    const commandCancellable = new Gio.Cancellable();

    if (cancellable) {
        if (cancellable.is_cancelled()) {
            commandCancellable.cancel();
        } else {
            cancellableHandlerId = cancellable.connect(() => {
                commandCancellable.cancel();
                subprocess.force_exit();
            });
        }
    }

    if (timeoutMs > 0) {
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timeoutId = 0;
            timedOut = true;
            console.warn(`NetBird CLI timed out after ${timeoutMs}ms: ${formatCommand(argv)}`);
            subprocess.force_exit();
            return GLib.SOURCE_REMOVE;
        });
    }

    try {
        const [stdout, stderr] = await Promise.all([
            readStream(subprocess.get_stdout_pipe(), commandCancellable, chunk => {
                logCliOutput('stdout', chunk);
                onStdout?.(chunk);
            }),
            readStream(subprocess.get_stderr_pipe(), commandCancellable, chunk => {
                logCliOutput('stderr', chunk);
                onStderr?.(chunk);
            }),
            waitForProcess(subprocess, commandCancellable),
        ]);
        const result = {
            argv,
            stdout: stdout?.trim() ?? '',
            stderr: stderr?.trim() ?? '',
            exitStatus: getExitStatus(subprocess),
            timedOut,
        };

        if (!subprocess.get_successful())
            throw new NetBirdCliError(result);

        return result;
    } catch (error) {
        if (error instanceof NetBirdCliError)
            throw error;

        console.warn(`NetBird CLI failed: ${formatCommand(argv)}: ${error}`);
        throw error;
    } finally {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        if (cancellable && cancellableHandlerId)
            cancellable.disconnect(cancellableHandlerId);
    }
}

export class NetBirdCliError extends Error {
    constructor(result) {
        const output = result.stderr || result.stdout ||
            (result.timedOut
                ? `netbird timed out after command started`
                : `netbird exited with status ${result.exitStatus}`);
        super(output);

        this.name = 'NetBirdCliError';
        this.argv = result.argv;
        this.exitStatus = result.exitStatus;
        this.result = result;
        this.stdout = result.stdout;
        this.stderr = result.stderr;
        this.timedOut = result.timedOut;
    }
}

function readStream(stream, cancellable, onChunk) {
    const decoder = new TextDecoder();
    const chunks = [];

    return new Promise((resolve, reject) => {
        function readNext() {
            stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    const bytes = source.read_bytes_finish(result);
                    if (bytes.get_size() === 0) {
                        resolve(chunks.join(''));
                        return;
                    }

                    const chunk = decoder.decode(bytes.toArray());
                    chunks.push(chunk);
                    onChunk(chunk);
                    readNext();
                } catch (error) {
                    reject(error);
                }
            });
        }

        readNext();
    });
}

function waitForProcess(subprocess, cancellable) {
    return new Promise((resolve, reject) => {
        subprocess.wait_async(cancellable, (proc, result) => {
            try {
                resolve(proc.wait_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function netbirdCommand() {
    return GLib.getenv('NETBIRD_CLI') || DEFAULT_NETBIRD_COMMAND;
}

function getExitStatus(subprocess) {
    if (subprocess.get_if_exited())
        return subprocess.get_exit_status();

    if (subprocess.get_if_signaled())
        return 128 + subprocess.get_term_sig();

    return -1;
}

function logCliOutput(streamName, chunk) {
    if (!DEBUG_CLI_OUTPUT)
        return;

    chunk.trim().split('\n').filter(Boolean).forEach(line => {
        const message = `NetBird CLI ${streamName}: ${line}`;
        if (streamName === 'stderr')
            console.warn(message);
        else
            console.log(message);
    });
}

function formatCommand(argv) {
    return argv.map(arg => GLib.shell_quote(arg)).join(' ');
}

function debugLog(message) {
    if (DEBUG_CLI_OUTPUT)
        console.log(message);
}
