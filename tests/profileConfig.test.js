import GLib from 'gi://GLib';

import {
    getActiveProfileConfigPath,
    MASKED_PRESHARED_KEY,
    readUrlValue,
    writeUrlValue,
} from '../profileConfig.js';


const tests = [
    ['readUrlValue string', () => {
        if (readUrlValue('https://api.netbird.io:443') !== 'https://api.netbird.io:443')
            throw new Error('expected string URL to pass through');
    }],
    ['readUrlValue object', () => {
        const value = readUrlValue({
            Scheme: 'https',
            Host: 'api.netbird.io:443',
            Path: '',
        });
        if (value !== 'https://api.netbird.io:443')
            throw new Error(`expected reconstructed URL, got ${value}`);
    }],
    ['writeUrlValue', () => {
        if (writeUrlValue('https://example.test:443') !== 'https://example.test:443')
            throw new Error('expected URL string write');
    }],
    ['getActiveProfileConfigPath default', () => {
        const path = getActiveProfileConfigPath('default');
        if (!path.endsWith('default.json'))
            throw new Error(`unexpected default profile path: ${path}`);
    }],
    ['masked pre-shared key constant', () => {
        if (MASKED_PRESHARED_KEY !== '**********')
            throw new Error('unexpected masked pre-shared key value');
    }],
];


async function main() {
    GLib.setenv('USER', 'test-user', true);

    for (const [name, test] of tests) {
        try {
            test();
            print(`ok ${name}`);
        } catch (error) {
            printerr(`not ok ${name} - ${error}\n`);
            throw error;
        }
    }
}

main();
