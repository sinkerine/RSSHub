/* oxlint-disable unicorn-js/no-this-outside-of-class -- Socket prototype interposition retains the existing receiver. */
import assert from 'node:assert/strict';
import net from 'node:net';

import { test } from 'vitest';

import { allowedTarget, installOutboundGuard } from './twitter-outbound-guard.mjs';

test('only literal loopback on the assigned fixture port is allowed', () => {
    for (const host of ['127.0.0.1', '::1']) {
        assert.equal(allowedTarget({ host, port: '34567' }, 34567), true);
    }
    for (const options of [
        { host: 'x.com', port: 443 },
        { host: 'cdn.jsdelivr.net', port: 443 },
        { host: 'localhost', port: 34567 },
        { host: '127.0.0.1', port: 34568 },
        { host: '127.0.0.1', port: 34567, path: '/tmp/socket' },
        { port: 34567 },
    ]) {
        assert.equal(allowedTarget(options, 34567), false);
    }
});

test('socket guard rejects before the real connector, including normalized positional arguments', () => {
    const original = net.Socket.prototype.connect;
    let calls = 0;
    net.Socket.prototype.connect = function () {
        calls++;
        return this;
    };
    const records = [];
    const restore = installOutboundGuard(34567, (entry) => {
        records.push(entry);
    });
    try {
        for (const args of [[{ host: 'x.com', port: 443 }], [443, 'cdn.jsdelivr.net'], [34567], ['/tmp/socket']]) {
            const socket = new net.Socket();
            assert.throws(() => socket.connect(...args), /E2E outbound blocked/);
            socket.destroy();
        }
        assert.equal(calls, 0);
        const socket = new net.Socket();
        socket.connect({ host: '127.0.0.1', port: 34567 });
        assert.equal(calls, 1);
        socket.destroy();
        const factorySocket = net.connect({ host: '127.0.0.1', port: 34567 });
        assert.equal(calls, 2, 'net.connect passes a pre-normalized argument array');
        factorySocket.destroy();
        assert.equal(records.filter((entry) => entry.event === 'blocked').length, 4);
        assert.equal(records[0].event, 'installed');
    } finally {
        restore();
        net.Socket.prototype.connect = original;
    }
});

test('missing or invalid fixture ports fail closed at installation', () => {
    for (const port of [NaN, 0, -1, 65536, 1.5]) {
        assert.throws(() => installOutboundGuard(port, () => {}), /requires the fixture port/);
    }
});
