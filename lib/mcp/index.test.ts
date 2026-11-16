/* eslint-disable no-await-in-loop -- These acceptance sequences share mutable server, queue or environment state. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Harness } from './test-harness';
import { fetchFeed, startHarness, textContent } from './test-harness';

let harness: Harness;
beforeAll(async () => {
    harness = await startHarness();
}, 30000);
afterAll(async () => {
    await harness?.close();
});
const data = (result) => {
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent;
};
const error = (result, code) => {
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe(code);
    return result.structuredContent.error;
};

describe('MCP integration', () => {
    describe('access', () => {
        it('ignores credentials and key, accepts listed/no Origin; rejects Origin before SDK factory or tools', async () => {
            const { createMcpEndpoint } = await import('./index');
            const logger = (await import('@/utils/logger')).default;
            const spy = vi.spyOn(logger, 'info');
            for (const headers of [{}, { Authorization: 'Bearer neverLoggedDummy' }, { Origin: 'https://allowed.example' }] as Array<Record<string, string>>) {
                const response = await fetch(`${harness.base}/mcp?key=wrong`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
                });
                expect(response.status).toBe(200);
                const body = await response.text();
                const message = response.headers.get('content-type')?.includes('text/event-stream')
                    ? JSON.parse(
                          body
                              .split('\n')
                              .find((line) => line.startsWith('data: '))!
                              .slice(6)
                      )
                    : JSON.parse(body);
                expect(message.result.serverInfo.name).toBe('rsshub');
            }
            const { checkOrigin } = await import('./origin');
            const { config } = await import('@/config');
            const factory = vi.spyOn(await import('./server'), 'buildMcpServer');
            const hits = harness.upstream.hits();
            spy.mockClear();
            for (const method of ['POST', 'GET', 'DELETE']) {
                const rejected = await fetch(`${harness.base}/mcp`, { method, headers: { Origin: 'https://evil.example' } });
                expect(rejected.status).toBe(403);
                expect(await rejected.json()).toEqual({ error: 'forbidden_origin' });
            }
            expect(harness.upstream.hits()).toBe(hits);
            expect(factory).not.toHaveBeenCalled();
            expect(spy.mock.calls.flat().join(' ')).not.toMatch(/mcp (?:fetch_feed|search_routes)/);
            factory.mockRestore();
            expect(spy.mock.calls.flat().join(' ')).not.toContain('neverLoggedDummy');
            expect(checkOrigin(new Request('http://localhost/mcp'), config.mcp)).toBeUndefined();
            expect(typeof createMcpEndpoint).toBe('function');
            spy.mockRestore();
        });
    });
    describe.each([false, true])('protocol modern=%s', (modern) => {
        it('connects real SDK client, lists exact typed tools and calls both', async () => {
            const client = await harness.connect(modern);
            expect(client.getServerVersion()?.name).toBe('rsshub');
            const tools = (await client.listTools()).tools;
            expect(tools.map((t) => t.name).toSorted()).toEqual(['fetch_feed', 'search_routes']);
            for (const tool of tools) {
                expect(tool.inputSchema).toBeDefined();
                expect(tool.outputSchema).toBeDefined();
                expect(tool.annotations?.readOnlyHint).toBe(true);
            }
            expect(data(await client.callTool({ name: 'search_routes', arguments: { query: 'twitter' } })).total).toBe(8);
            expect(data(await fetchFeed(client, '/test/1')).items).toHaveLength(5);
            for (const method of ['GET', 'DELETE']) {
                expect((await fetch(`${harness.base}/mcp`, { method })).status).toBe(405);
            }
        });
        it('schema validation rejects empty and overlong paths without dispatch', async () => {
            const client = await harness.connect(modern);
            const logger = (await import('@/utils/logger')).default;
            const spy = vi.spyOn(logger, 'info');
            const hits = harness.upstream.hits();
            try {
                for (const path of ['', '/' + 'a'.repeat(2048)]) {
                    const result = await fetchFeed(client, path);
                    expect(result.isError).toBe(true);
                    expect(textContent(result)).toMatch(/^Input validation error/);
                }
                expect(harness.upstream.hits()).toBe(hits);
                expect(spy.mock.calls.flat().join(' ')).not.toMatch(/GET /);
            } finally {
                spy.mockRestore();
            }
        });
        it('fetch_feed success equals own JSON pipeline ordering and resolved links', async () => {
            const client = await harness.connect(modern);
            const result = await fetchFeed(client, `/e2e-mcp/feed/success-${modern}`);
            const output = data(result);
            const json = await (await fetch(`${harness.base}/e2e-mcp/feed/success-${modern}?format=json&key=${harness.key}`)).json();
            expect(output.items.map((i) => ({ title: i.title, link: i.link, guid: i.guid, pubDate: i.pubDate }))).toEqual(json.items.map((i) => ({ title: i.title, link: i.url, guid: i.id, pubDate: i.date_published })));
            expect(JSON.parse(textContent(result))).toEqual(output);
            const { fetchFeedOutputSchema } = await import('./result');
            expect(fetchFeedOutputSchema.safeParse(output).success).toBe(true);
        });
    });
    it('search_routes returns eight defaults, pagination and user routes', async () => {
        const client = await harness.connect();
        const twitter = data(await client.callTool({ name: 'search_routes', arguments: { query: 'twitter' } }));
        const { DEFAULT_MCP_ROUTES } = await import('@/config');
        expect(twitter.routes.map((r) => r.path).toSorted()).toEqual([...DEFAULT_MCP_ROUTES].toSorted());
        expect(twitter.routes.flatMap((r) => r.requiresConfig).some((c) => c.name === 'TWITTER_AUTH_TOKEN')).toBe(true);
        const all = data(await client.callTool({ name: 'search_routes', arguments: { limit: 50 } }));
        expect(all.total).toBe(15);
        expect(all.routes.map((r) => r.path)).toEqual(all.routes.map((r) => r.path).toSorted());
        const page = data(await client.callTool({ name: 'search_routes', arguments: { limit: 3, offset: 3 } }));
        expect(page.nextOffset).toBe(6);
    });
    it('bounds: default/invalid limits, modes, content, bytes and honest cache snapshots', async () => {
        const client = await harness.connect();
        for (const limit of [0, 11]) {
            const result = await fetchFeed(client, '/e2e-mcp/feed/big', { limit });
            expect(result.isError).toBe(true);
            expect(textContent(result)).toMatch(/^Input validation error/);
        }
        const full = data(await fetchFeed(client, '/e2e-mcp/feed/big', { content: 'none' }));
        expect(full.returnedCount).toBe(10);
        expect(full.itemCount).toBe(30);
        expect(full.items[0].content).toBeUndefined();
        const clipped = data(await fetchFeed(client, '/e2e-mcp/feed/big', { content: 'html', limit: 10 }));
        expect(Buffer.byteLength(JSON.stringify(clipped))).toBeLessThanOrEqual(16384);
        expect(clipped.truncation.bytes).toBe(true);
        expect(clipped.items.every((i) => i.content.length <= 4000)).toBe(true);
        expect(clipped.snapshot.pagination).toBe('none');
    });
    it('errors: built-in routes, fixture errors, real Twitter missing config and genuine empty success only', async () => {
        const client = await harness.connect();
        for (const [path, code] of [
            ['/test/config-not-found-error', 'source_config_missing'],
            ['/test/invalid-parameter-error', 'invalid_parameter'],
            ['/test/captcha-error', 'captcha_required'],
            ['/test/error', 'upstream_error'],
            ['/test/redirect', 'unsupported_result'],
            ['/test/empty', 'empty_result'],
            ['/e2e-mcp/empty', 'empty_result'],
            ['/e2e-mcp/raw', 'unsupported_result'],
            ['/e2e-mcp/fail/twitter-429', 'upstream_rate_limited'],
            ['/e2e-mcp/fail/config', 'source_config_missing'],
            ['/twitter/user/_RSSHub', 'source_config_missing'],
        ]) {
            error(await fetchFeed(client, path), code);
        }
        expect(error(await fetchFeed(client, '/e2e-mcp/fail/rate-limit'), 'upstream_rate_limited').retryAfterSeconds).toBe(120);
        for (const path of ['/test/allow_empty', '/e2e-mcp/empty-ok']) {
            expect(data(await fetchFeed(client, path))).toMatchObject({ items: [], itemCount: 0 });
        }
    });
    it('restriction rejects non-feed/nonallowlisted/recursive/invalid paths without dispatch', async () => {
        const client = await harness.connect();
        const before = harness.upstream.hits();
        for (const path of ['/twitter/trends/23424856', '/mcp', '/api/namespace', '/healthz', '/', '/metrics', '/robots.txt']) {
            error(await fetchFeed(client, path), 'route_not_allowed');
        }
        for (const path of ['/e2e-mcp/feed/a?format=json', '/a#x', '/e2e-mcp/../api/namespace', '/e2e-mcp/%2e%2e/api/namespace', 'e2e-mcp/feed/a']) {
            error(await fetchFeed(client, path), 'invalid_arguments');
        }
        expect(harness.upstream.hits()).toBe(before);
    });
    it('no secrets: errors/discovery/results and raw response bodies', async () => {
        const client = await harness.connect();
        const secret = error(await fetchFeed(client, '/e2e-mcp/fail/secret'), 'upstream_error');
        expect(secret.message).toContain('[redacted]');
        expect(secret.message).not.toContain('api_key=');
        await client.callTool({ name: 'search_routes', arguments: {} });
        await fetchFeed(client, '/e2e-mcp/feed/secret-scan');
        for (const body of harness.bodies) {
            expect(body).not.toContain(harness.key);
        }
    });
});

describe.each([false, true])('MCP review regressions modern=%s', (modern) => {
    it('rejects an excluded namespace root before the real root handler despite an allowed optional overlap', async () => {
        const local = await startHarness({ routes: '/e2e-mcp/:id?' });
        try {
            const external = await fetch(`${local.base}/e2e-mcp?key=${local.key}`);
            expect(external.status).toBe(200);
            expect(local.upstream.hits('/feed/root')).toBe(1);
            const client = await local.connect(modern);
            error(await fetchFeed(client, '/e2e-mcp'), 'route_not_allowed');
            expect(local.upstream.hits('/feed/root')).toBe(1);
            expect(local.upstream.hits('/feed/optional')).toBe(0);
            data(await fetchFeed(client, '/e2e-mcp/allowed'));
            expect(local.upstream.hits('/feed/optional')).toBe(1);
        } finally {
            await local.close();
        }
    }, 30000);
    it('discovers canonical namespace root aliases and fetches the root through the real feed pipeline', async () => {
        const local = await startHarness({ routes: '/e2e-mcp/,/e2e-mcp,/e2e-mcp/:id?' });
        try {
            const client = await local.connect(modern);
            const discovered = data(await client.callTool({ name: 'search_routes', arguments: { query: 'canonical' } }));
            expect(discovered.total).toBe(1);
            expect(discovered.routes[0]).toMatchObject({ path: '/e2e-mcp', name: 'Canonical root fixture', parameters: [] });
            const output = data(await fetchFeed(client, discovered.routes[0].path));
            expect(output.route.path).toBe('/e2e-mcp');
            expect(output.items).toHaveLength(3);
            expect(local.upstream.hits('/feed/root')).toBe(1);
            expect(local.upstream.hits('/feed/optional')).toBe(0);
        } finally {
            await local.close();
        }
    }, 30000);
    it('redacts discovery string values before JSON serialization while preserving metadata formatting and source content', async () => {
        const secret = 'fixture"quoted\\credential\nsecret';
        const local = await startHarness({ routes: '/e2e-mcp/metadata/:id?', accessKey: secret });
        try {
            const client = await local.connect(modern);
            const result = await client.callTool({ name: 'search_routes', arguments: { query: 'metadata formatting' } });
            const discovered = data(result);
            expect(discovered.total).toBe(1);
            expect(discovered.routes[0]).toMatchObject({
                path: '/e2e-mcp/metadata/:id?',
                description: 'Visit "https://example.com"\nSee [site](https://example.com)\n<a href="https://example.com/docs">docs</a>\nWindows C:\\notes\\file\nCredential: [redacted]\n(https://example.com/private[redacted])',
                parameters: [{ name: 'id', optional: true, description: 'Credential: [redacted]', default: '[redacted]', options: [String.raw`C:\notes\file`] }],
            });
            expect(JSON.parse(textContent(result))).toEqual(discovered);
            expect(JSON.stringify(discovered)).not.toContain(JSON.stringify(secret).slice(1, -1));
            const source = data(await fetchFeed(client, '/e2e-mcp/metadata/value', { content: 'html' }));
            expect(source.items[0].content).toBe(secret);
        } finally {
            await local.close();
        }
    }, 30000);
});
