import {NetBirdGrpcError} from './netbirdErrors.js';


const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();


export class ProtoReader {
    constructor(bytes) {
        this._bytes = bytes;
        this._offset = 0;
    }

    get done() {
        return this._offset >= this._bytes.length;
    }

    readTag() {
        if (this.done)
            return null;

        // A protobuf tag packs the field number and wire type into one varint:
        // (field << 3) | wireType.
        const tag = this.readVarint();
        return {
            field: Number(tag >> 3n),
            wireType: Number(tag & 0x7n),
        };
    }

    readVarint() {
        let shift = 0n;
        let value = 0n;

        while (this._offset < this._bytes.length) {
            const byte = this._bytes[this._offset++];
            value |= BigInt(byte & 0x7f) << shift;

            if ((byte & 0x80) === 0)
                return value;

            shift += 7n;
        }

        throw new NetBirdGrpcError('Unexpected end of protobuf varint');
    }

    readBool() {
        return this.readVarint() !== 0n;
    }

    readBytes() {
        const length = Number(this.readVarint());
        this._require(length);

        const value = this._bytes.slice(this._offset, this._offset + length);
        this._offset += length;
        return value;
    }

    readString() {
        return textDecoder.decode(this.readBytes());
    }

    skip(wireType) {
        switch (wireType) {
        case 0:
            this.readVarint();
            break;
        case 1:
            this._require(8);
            this._offset += 8;
            break;
        case 2:
            this.readBytes();
            break;
        case 5:
            this._require(4);
            this._offset += 4;
            break;
        default:
            throw new NetBirdGrpcError(`Unsupported protobuf wire type ${wireType}`);
        }
    }

    _require(length) {
        if (this._offset + length > this._bytes.length)
            throw new NetBirdGrpcError('Unexpected end of protobuf message');
    }
}

export class ProtoWriter {
    constructor() {
        this._bytes = [];
    }

    writeString(field, value) {
        if (value === null || value === undefined || value === '')
            return;

        const bytes = textEncoder.encode(value);
        this._writeTag(field, 2);
        this._writeVarint(BigInt(bytes.length));
        this._writeBytes(bytes);
    }

    writeBool(field, value) {
        if (value === null || value === undefined)
            return;

        this._writeTag(field, 0);
        this._writeVarint(value ? 1n : 0n);
    }

    writeBytes(field, value) {
        if (value === null || value === undefined)
            return;

        this._writeTag(field, 2);
        this._writeVarint(BigInt(value.length));
        this._writeBytes(value);
    }

    finish() {
        return Uint8Array.from(this._bytes);
    }

    _writeTag(field, wireType) {
        // The NetBird daemon profile calls only need a small subset here:
        // strings/nested messages use wire type 2, and booleans use wire type 0.
        this._writeVarint(BigInt((field << 3) | wireType));
    }

    _writeVarint(value) {
        while (value > 0x7fn) {
            this._bytes.push(Number((value & 0x7fn) | 0x80n));
            value >>= 7n;
        }

        this._bytes.push(Number(value));
    }

    _writeBytes(bytes) {
        for (const byte of bytes)
            this._bytes.push(byte);
    }
}
