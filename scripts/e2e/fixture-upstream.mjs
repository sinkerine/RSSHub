import { createServer } from 'node:http';

export async function startFixtureUpstream() {
    const requests = [];
    const holds = new Map();
    const waiters = new Map();
    const server = createServer(async (req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        requests.push({ path: pathname, at: Date.now() });
        const waiting = waiters.get(pathname) || [];
        for (const resolve of waiting) {
            resolve();
        }
        waiters.delete(pathname);
        const id = pathname.split('/').at(-1);
        if (holds.has(id)) {
            await holds.get(id).promise;
        }
        const item = Array.from({ length: id === 'big' ? 30 : 3 }, (_, index) => ({
            title: `${id} article ${index}`,
            link: `/${id}/${index}`,
            pubDate: new Date(Date.UTC(2025, 0, 30 - index)).toISOString(),
            description: id === 'big' ? (index === 0 ? `<p>${'content '.repeat(750)}</p>` : `<p data-note="${'metadata'.repeat(500)}">${'content '.repeat(250)}</p>`) : '<p>Fixture content</p>',
            category: ['fixture'],
            author: 'Fixture author',
        })).toReversed();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ title: 'RSSHub MCP fixture', link: 'https://example.com', description: 'Fixture feed', item }));
    });
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        hits: (pathname) => (pathname ? requests.filter((entry) => entry.path === pathname).length : requests.length),
        log: () => [...requests],
        hold(id) {
            const { promise, resolve: release } = Promise.withResolvers();
            holds.set(id, { promise, release });
        },
        release(id) {
            holds.get(id)?.release();
            holds.delete(id);
        },
        waitFor(pathname) {
            if (requests.some((entry) => entry.path === pathname)) {
                return Promise.resolve();
            }
            return new Promise((resolve) => waiters.set(pathname, [...(waiters.get(pathname) || []), resolve]));
        },
        async close() {
            for (const hold of holds.values()) {
                hold.release();
            }
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
