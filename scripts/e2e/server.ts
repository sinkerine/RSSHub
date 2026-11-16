import server from '../../lib/index';

if (!server) {
    throw new Error('E2E requires a single RSSHub server (ENABLE_CLUSTER=false).');
}

const ready = () => process.send?.({ port: (server.address() as { port: number }).port });
if (server.listening) {
    ready();
} else {
    server.once('listening', ready);
}
