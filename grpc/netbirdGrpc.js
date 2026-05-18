import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {NetBirdGrpcError} from './netbirdErrors.js';
import {
    HpackDecoder,
    encodeHeaderWithoutIndexing,
} from './netbirdHpack.js';
export {NetBirdGrpcError} from './netbirdErrors.js';
export {
    ProtoReader,
    ProtoWriter,
} from './netbirdProto.js';
export {HpackDecoder} from './netbirdHpack.js';


const HTTP2_PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';

const FRAME_DATA = 0x0;
const FRAME_HEADERS = 0x1;
const FRAME_SETTINGS = 0x4;
const FRAME_PING = 0x6;
const FRAME_GOAWAY = 0x7;
const FRAME_WINDOW_UPDATE = 0x8;
const FRAME_CONTINUATION = 0x9;

const FLAG_ACK = 0x1;
const FLAG_END_STREAM = 0x1;
const FLAG_END_HEADERS = 0x4;
const FLAG_PADDED = 0x8;
const FLAG_PRIORITY = 0x20;

const DEFAULT_SOCKET_PATHS = [
    '/var/run/netbird.sock',
    '/run/netbird.sock',
];
const DEFAULT_TIMEOUT_MS = 5000;

const textEncoder = new TextEncoder();


export class NetBirdGrpcClient {
    constructor({socketPath = null, socketPaths = DEFAULT_SOCKET_PATHS} = {}) {
        this._socketPaths = socketPath ? [socketPath] : socketPaths;
        this._nextStreamId = 1;
    }

    unary(service, method, requestBytes = new Uint8Array(), cancellable = null) {
        const connection = this._connect(cancellable);

        try {
            const input = connection.get_input_stream();
            const output = connection.get_output_stream();
            const streamId = this._nextStreamId;
            this._nextStreamId += 2;

            this._writeRequest(output, streamId, service, method, requestBytes, cancellable);
            return this._readUnaryResponse(input, output, streamId, cancellable);
        } finally {
            connection.close(cancellable);
        }
    }

    async unaryAsync(service, method, requestBytes = new Uint8Array(), {
        cancellable = null,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    } = {}) {
        const operationCancellable = new Gio.Cancellable();
        let cancellableSignalId = 0;
        let timedOut = false;
        let timeoutId = 0;

        if (cancellable?.is_cancelled()) {
            operationCancellable.cancel();
        } else if (cancellable) {
            cancellableSignalId = cancellable.connect(() => {
                operationCancellable.cancel();
            });
        }

        if (timeoutMs > 0) {
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timedOut = true;
                operationCancellable.cancel();
                timeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });
        }

        try {
            return await this._unaryAsync(service, method, requestBytes, operationCancellable);
        } catch (error) {
            if (timedOut) {
                throw new NetBirdGrpcError('NetBird daemon gRPC request timed out', {
                    cause: error,
                    timeoutMs,
                });
            }

            throw error;
        } finally {
            if (timeoutId)
                GLib.source_remove(timeoutId);

            if (cancellableSignalId)
                cancellable.disconnect(cancellableSignalId);
        }
    }

    async _unaryAsync(service, method, requestBytes, cancellable) {
        const connection = await this._connectAsync(cancellable);

        try {
            const input = connection.get_input_stream();
            const output = connection.get_output_stream();
            const streamId = this._nextStreamId;
            this._nextStreamId += 2;

            await this._writeRequestAsync(output, streamId, service, method, requestBytes, cancellable);
            return await this._readUnaryResponseAsync(input, output, streamId, cancellable);
        } finally {
            connection.close(cancellable);
        }
    }

    _connect(cancellable) {
        const client = new Gio.SocketClient();
        let lastError = null;

        for (const socketPath of this._socketPaths) {
            try {
                const address = Gio.UnixSocketAddress.new(socketPath);
                return client.connect(address, cancellable);
            } catch (error) {
                lastError = error;
            }
        }

        throw new NetBirdGrpcError('Unable to connect to the NetBird daemon socket', {
            cause: lastError,
            socketPaths: this._socketPaths,
        });
    }

    async _connectAsync(cancellable) {
        const client = new Gio.SocketClient();
        let lastError = null;

        for (const socketPath of this._socketPaths) {
            if (cancellable?.is_cancelled())
                break;

            try {
                const address = Gio.UnixSocketAddress.new(socketPath);
                return await connectAsync(client, address, cancellable);
            } catch (error) {
                lastError = error;
            }
        }

        throw new NetBirdGrpcError('Unable to connect to the NetBird daemon socket', {
            cause: lastError,
            socketPaths: this._socketPaths,
        });
    }

    _writeRequest(output, streamId, service, method, requestBytes, cancellable) {
        // A fresh HTTP/2 connection starts with the client preface and SETTINGS.
        // The RPC itself is HEADERS followed by one DATA frame containing the
        // gRPC-framed protobuf request.
        output.write_all(textEncoder.encode(HTTP2_PREFACE), cancellable);
        this._writeFrame(output, FRAME_SETTINGS, 0, 0, new Uint8Array(), cancellable);
        this._writeFrame(output, FRAME_HEADERS, FLAG_END_HEADERS, streamId,
            this._encodeRequestHeaders(service, method), cancellable);
        this._writeFrame(output, FRAME_DATA, FLAG_END_STREAM, streamId,
            encodeGrpcMessage(requestBytes), cancellable);
    }

    async _writeRequestAsync(output, streamId, service, method, requestBytes, cancellable) {
        // Same sequence as _writeRequest(), but every socket operation yields
        // back to GNOME Shell's main loop and can be cancelled by timeout.
        await writeAllAsync(output, textEncoder.encode(HTTP2_PREFACE), cancellable);
        await this._writeFrameAsync(output, FRAME_SETTINGS, 0, 0, new Uint8Array(), cancellable);
        await this._writeFrameAsync(output, FRAME_HEADERS, FLAG_END_HEADERS, streamId,
            this._encodeRequestHeaders(service, method), cancellable);
        await this._writeFrameAsync(output, FRAME_DATA, FLAG_END_STREAM, streamId,
            encodeGrpcMessage(requestBytes), cancellable);
    }

    _readUnaryResponse(input, output, streamId, cancellable) {
        let headers = {};
        let trailers = {};
        const chunks = [];
        const hpackDecoder = new HpackDecoder();

        while (true) {
            const frame = this._readFrame(input, cancellable);
            const result = this._handleResponseFrame(frame, input, output, streamId, hpackDecoder, cancellable);

            if (!result)
                continue;

            if (result.headers)
                headers = result.headers;
            if (result.trailers)
                trailers = result.trailers;
            if (result.data)
                chunks.push(result.data);
            if (result.done)
                break;
        }

        return decodeUnaryResult(headers, trailers, chunks);
    }

    async _readUnaryResponseAsync(input, output, streamId, cancellable) {
        let headers = {};
        let trailers = {};
        const chunks = [];
        const hpackDecoder = new HpackDecoder();

        while (true) {
            const frame = await this._readFrameAsync(input, cancellable);
            const result = await this._handleResponseFrameAsync(frame, input, output, streamId, hpackDecoder, cancellable);

            if (!result)
                continue;

            if (result.headers)
                headers = result.headers;
            if (result.trailers)
                trailers = result.trailers;
            if (result.data)
                chunks.push(result.data);
            if (result.done)
                break;
        }

        return decodeUnaryResult(headers, trailers, chunks);
    }

    _handleResponseFrame(frame, input, output, streamId, hpackDecoder, cancellable) {
        if (frame.type === FRAME_SETTINGS) {
            if ((frame.flags & FLAG_ACK) === 0)
                this._writeFrame(output, FRAME_SETTINGS, FLAG_ACK, 0, new Uint8Array(), cancellable);
            return null;
        }

        if (frame.type === FRAME_PING) {
            if ((frame.flags & FLAG_ACK) === 0)
                this._writeFrame(output, FRAME_PING, FLAG_ACK, 0, frame.payload, cancellable);
            return null;
        }

        if (frame.type === FRAME_WINDOW_UPDATE || frame.streamId !== streamId)
            return null;

        if (frame.type === FRAME_GOAWAY)
            throw new NetBirdGrpcError('NetBird daemon closed the HTTP/2 connection');

        if (frame.type === FRAME_HEADERS) {
            const headerBlock = this._readHeaderBlock(input, frame, cancellable);
            const decodedHeaders = hpackDecoder.decode(headerBlock);

            return frame.flags & FLAG_END_STREAM
                ? {trailers: decodedHeaders, done: true}
                : {headers: decodedHeaders};
        }

        if (frame.type === FRAME_DATA)
            return {data: frame.payload, done: Boolean(frame.flags & FLAG_END_STREAM)};

        return null;
    }

    async _handleResponseFrameAsync(frame, input, output, streamId, hpackDecoder, cancellable) {
        if (frame.type === FRAME_SETTINGS) {
            if ((frame.flags & FLAG_ACK) === 0)
                await this._writeFrameAsync(output, FRAME_SETTINGS, FLAG_ACK, 0, new Uint8Array(), cancellable);
            return null;
        }

        if (frame.type === FRAME_PING) {
            if ((frame.flags & FLAG_ACK) === 0)
                await this._writeFrameAsync(output, FRAME_PING, FLAG_ACK, 0, frame.payload, cancellable);
            return null;
        }

        if (frame.type === FRAME_WINDOW_UPDATE || frame.streamId !== streamId)
            return null;

        if (frame.type === FRAME_GOAWAY)
            throw new NetBirdGrpcError('NetBird daemon closed the HTTP/2 connection');

        if (frame.type === FRAME_HEADERS) {
            const headerBlock = await this._readHeaderBlockAsync(input, frame, cancellable);
            const decodedHeaders = hpackDecoder.decode(headerBlock);

            return frame.flags & FLAG_END_STREAM
                ? {trailers: decodedHeaders, done: true}
                : {headers: decodedHeaders};
        }

        if (frame.type === FRAME_DATA)
            return {data: frame.payload, done: Boolean(frame.flags & FLAG_END_STREAM)};

        return null;
    }

    _readFrame(input, cancellable) {
        return decodeHttp2Frame(readExact(input, 9, cancellable), length =>
            readExact(input, length, cancellable));
    }

    async _readFrameAsync(input, cancellable) {
        const header = await readExactAsync(input, 9, cancellable);
        return decodeHttp2Frame(header, length => readExactAsync(input, length, cancellable));
    }

    _writeFrame(output, type, flags, streamId, payload, cancellable) {
        output.write_all(buildHttp2Frame(type, flags, streamId, payload), cancellable);
        output.flush(cancellable);
    }

    async _writeFrameAsync(output, type, flags, streamId, payload, cancellable) {
        await writeAllAsync(output, buildHttp2Frame(type, flags, streamId, payload), cancellable);
        await flushAsync(output, cancellable);
    }

    _readHeaderBlock(input, frame, cancellable) {
        let payload = headerPayload(frame);

        while ((frame.flags & FLAG_END_HEADERS) === 0) {
            frame = this._readFrame(input, cancellable);
            if (frame.type !== FRAME_CONTINUATION)
                throw new NetBirdGrpcError('Expected HTTP/2 CONTINUATION frame');
            payload = concatBytes([payload, frame.payload]);
        }

        return payload;
    }

    async _readHeaderBlockAsync(input, frame, cancellable) {
        let payload = headerPayload(frame);

        while ((frame.flags & FLAG_END_HEADERS) === 0) {
            frame = await this._readFrameAsync(input, cancellable);
            if (frame.type !== FRAME_CONTINUATION)
                throw new NetBirdGrpcError('Expected HTTP/2 CONTINUATION frame');
            payload = concatBytes([payload, frame.payload]);
        }

        return payload;
    }

    _encodeRequestHeaders(service, method) {
        const headers = [
            [':method', 'POST'],
            [':scheme', 'http'],
            [':path', `/${service}/${method}`],
            [':authority', 'localhost'],
            ['content-type', 'application/grpc'],
            ['te', 'trailers'],
            ['grpc-accept-encoding', 'identity'],
            ['user-agent', 'netbird-gnome-gjs'],
        ];

        return concatBytes(headers.map(([name, value]) => encodeHeaderWithoutIndexing(name, value)));
    }
}

function decodeUnaryResult(headers, trailers, chunks) {
    const grpcStatus = trailers['grpc-status'] ?? headers['grpc-status'] ?? '0';
    if (grpcStatus !== '0') {
        throw new NetBirdGrpcError(trailers['grpc-message'] || 'NetBird daemon returned a gRPC error', {
            grpcStatus,
            headers,
            trailers,
        });
    }

    return decodeGrpcMessages(concatBytes(chunks))[0] ?? new Uint8Array();
}

function encodeGrpcMessage(message) {
    // gRPC wraps each protobuf payload in a 5-byte prefix: compressed flag,
    // then a 32-bit big-endian message length.
    const frame = new Uint8Array(5 + message.length);
    frame[0] = 0;
    frame[1] = (message.length >> 24) & 0xff;
    frame[2] = (message.length >> 16) & 0xff;
    frame[3] = (message.length >> 8) & 0xff;
    frame[4] = message.length & 0xff;
    frame.set(message, 5);
    return frame;
}

function decodeGrpcMessages(bytes) {
    const messages = [];
    let offset = 0;

    while (offset < bytes.length) {
        const compressed = bytes[offset++];
        if (compressed !== 0)
            throw new NetBirdGrpcError('Compressed gRPC messages are not supported yet');

        const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += 4;

        messages.push(bytes.slice(offset, offset + length));
        offset += length;
    }

    return messages;
}

function decodeHttp2Frame(header, readPayload) {
    const length = (header[0] << 16) | (header[1] << 8) | header[2];
    const type = header[3];
    const flags = header[4];
    const streamId = ((header[5] & 0x7f) << 24) | (header[6] << 16) | (header[7] << 8) | header[8];
    const payload = readPayload(length);

    return payload instanceof Promise
        ? payload.then(resolvedPayload => ({length, type, flags, streamId, payload: resolvedPayload}))
        : {length, type, flags, streamId, payload};
}

function buildHttp2Frame(type, flags, streamId, payload) {
    const frame = new Uint8Array(9 + payload.length);
    frame[0] = (payload.length >> 16) & 0xff;
    frame[1] = (payload.length >> 8) & 0xff;
    frame[2] = payload.length & 0xff;
    frame[3] = type;
    frame[4] = flags;
    frame[5] = (streamId >> 24) & 0x7f;
    frame[6] = (streamId >> 16) & 0xff;
    frame[7] = (streamId >> 8) & 0xff;
    frame[8] = streamId & 0xff;
    frame.set(payload, 9);
    return frame;
}

function headerPayload(frame) {
    let offset = 0;
    let length = frame.payload.length;

    if (frame.flags & FLAG_PADDED) {
        const padding = frame.payload[offset++];
        length -= padding + 1;
    }

    if (frame.flags & FLAG_PRIORITY)
        offset += 5;

    return frame.payload.slice(offset, length);
}

function connectAsync(client, address, cancellable) {
    return new Promise((resolve, reject) => {
        client.connect_async(address, cancellable, (source, result) => {
            try {
                resolve(source.connect_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function writeAllAsync(output, bytes, cancellable) {
    return new Promise((resolve, reject) => {
        output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                source.write_all_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

function flushAsync(output, cancellable) {
    return new Promise((resolve, reject) => {
        output.flush_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                source.flush_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

function readExact(input, length, cancellable) {
    const chunks = [];
    let remaining = length;

    while (remaining > 0) {
        const bytes = input.read_bytes(remaining, cancellable);
        if (bytes.get_size() === 0)
            throw new NetBirdGrpcError('Unexpected end of socket stream');

        const chunk = bytes.get_data();
        chunks.push(chunk);
        remaining -= chunk.length;
    }

    return concatBytes(chunks);
}

async function readExactAsync(input, length, cancellable) {
    const chunks = [];
    let remaining = length;

    while (remaining > 0) {
        const bytes = await readBytesAsync(input, remaining, cancellable);
        if (bytes.get_size() === 0)
            throw new NetBirdGrpcError('Unexpected end of socket stream');

        const chunk = bytes.get_data();
        chunks.push(chunk);
        remaining -= chunk.length;
    }

    return concatBytes(chunks);
}

function readBytesAsync(input, length, cancellable) {
    return new Promise((resolve, reject) => {
        input.read_bytes_async(length, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                resolve(source.read_bytes_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function concatBytes(chunks) {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }

    return bytes;
}
