#!/usr/bin/env -S gjs -m

import {
    HpackDecoder,
} from './grpc/netbirdHpack.js';
import {
    ProtoWriter,
} from './grpc/netbirdProto.js';
import {
    decodeGetActiveProfileResponse,
    decodeListProfilesResponse,
} from './netbirdProfiles.js';


function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function assertJsonEqual(actual, expected, message) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);

    if (actualJson !== expectedJson)
        throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
}

function encodeProfile(name, selected) {
    const writer = new ProtoWriter();
    writer.writeString(1, name);
    writer.writeBool(2, selected);
    return writer.finish();
}

function testListProfilesDecoding() {
    const response = new ProtoWriter();
    response.writeBytes(1, encodeProfile('default', false));
    response.writeBytes(1, encodeProfile('CameronKnauffHosted', true));
    response.writeString(99, 'ignored future field');

    assertJsonEqual(decodeListProfilesResponse(response.finish()), [
        {name: 'default', selected: false},
        {name: 'CameronKnauffHosted', selected: true},
    ], 'ListProfiles protobuf decode');
}

function testActiveProfileDecoding() {
    const response = new ProtoWriter();
    response.writeString(1, 'CameronKnauffHosted');
    response.writeString(2, 'cameronknauff');

    assertJsonEqual(decodeGetActiveProfileResponse(response.finish()), {
        profileName: 'CameronKnauffHosted',
        username: 'cameronknauff',
    }, 'GetActiveProfile protobuf decode');
}

function testHpackHuffmanDecoding() {
    // RFC 7541 Appendix C.4.1: literal ":authority" value
    // "www.example.com", Huffman encoded.
    const headers = new HpackDecoder().decode(Uint8Array.of(
        0x41, 0x8c, 0xf1, 0xe3, 0xc2, 0xe5, 0xf2,
        0x3a, 0x6b, 0xa0, 0xab, 0x90, 0xf4, 0xff));

    assertEqual(headers[':authority'], 'www.example.com', 'HPACK Huffman decode');
}

const tests = [
    testListProfilesDecoding,
    testActiveProfileDecoding,
    testHpackHuffmanDecoding,
];

try {
    for (const test of tests)
        test();

    print(`ok - ${tests.length} protocol tests passed`);
} catch (error) {
    printerr(`${error.name ?? 'Error'}: ${error.message}`);
    imports.system.exit(1);
}
