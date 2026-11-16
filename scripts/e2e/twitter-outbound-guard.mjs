/* oxlint-disable unicorn-js/no-this-outside-of-class -- Socket prototype interposition retains the existing receiver. */
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

export function allowedTarget(options, port) {
    return !options.path && ['127.0.0.1', '::1'].includes(options.host) && Number(options.port) === port;
}

export function installOutboundGuard(port, record) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error('Outbound guard requires the fixture port');
    }
    const connect = net.Socket.prototype.connect;
    // All Node TCP/TLS clients, including explicit undici CookieAgent dispatchers,
    // pass through Socket.connect. Literal addresses avoid DNS rebinding.
    net.Socket.prototype.connect = function (...args) {
        const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
        const target = { host: options.host || 'localhost', port: Number(options.port) || undefined };
        if (!allowedTarget(options, port)) {
            record({ event: 'blocked', ...target });
            throw new Error(`E2E outbound blocked: ${target.host}:${target.port || 'socket'}`);
        }
        this.once('connect', () => {
            const permitted = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(this.remoteAddress) && this.remotePort === port;
            record({ event: permitted ? 'connected' : 'violation', host: this.remoteAddress, port: this.remotePort });
            if (!permitted) {
                this.destroy(new Error('E2E outbound guard remote-address violation'));
            }
        });
        return connect.apply(this, args);
    };
    syncBuiltinESMExports();
    record({ event: 'installed', port });
    return () => {
        net.Socket.prototype.connect = connect;
        syncBuiltinESMExports();
    };
}

if (process.env.E2E_OUTBOUND_LOG) {
    installOutboundGuard(Number(process.env.E2E_FIXTURE_PORT), (entry) => appendFileSync(process.env.E2E_OUTBOUND_LOG, `${JSON.stringify(entry)}\n`));
}
