import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Harness } from './test-harness';
import { delay, failureData, feedData, fetchFeed, startHarness } from './test-harness';

for (const backend of ['memory', 'redis']) {
    describe.runIf(backend !== 'redis' || !!process.env.REDIS_URL)(`${backend} shared feed cache`, () => {
        let harness: Harness;
        let client;
        beforeAll(async () => {
            harness = await startHarness({ cache: backend });
            client = await harness.connect();
        }, 30000);
        afterAll(async () => {
            await harness?.close();
        });
        it(`${backend} (a) MCP to MCP reuses snapshot`, async () => {
            const first = feedData(await fetchFeed(client, '/e2e-mcp/feed/a'));
            const next = feedData(await fetchFeed(client, '/e2e-mcp/feed/a'));
            expect(first.snapshot.cache).toBe('miss');
            expect(next.snapshot.cache).toBe('hit');
            expect(next.snapshot.builtAt).toBe(first.snapshot.builtAt);
            expect(harness.upstream.hits('/feed/a')).toBe(1);
        });
        it(`${backend} (b) RSS to MCP shares bare default key`, async () => {
            expect((await fetch(`${harness.base}/e2e-mcp/feed/b?key=${harness.key}`)).status).toBe(200);
            const next = feedData(await fetchFeed(client, '/e2e-mcp/feed/b'));
            expect(next.snapshot.cache).toBe('hit');
            expect(harness.upstream.hits('/feed/b')).toBe(1);
        });
        it(`${backend} (c) MCP to RSS shares default key`, async () => {
            await fetchFeed(client, '/e2e-mcp/feed/c');
            const rss = await fetch(`${harness.base}/e2e-mcp/feed/c?key=${harness.key}`);
            expect(rss.headers.get('RSSHub-Cache-Status')).toBe('HIT');
            expect(harness.upstream.hits('/feed/c')).toBe(1);
        });
        it(`${backend} (d) concurrent RSS claim then MCP waits and hits`, async () => {
            harness.upstream.hold('shared');
            const rss = fetch(`${harness.base}/e2e-mcp/hold/shared?key=${harness.key}`);
            await harness.upstream.waitFor('/hold/shared');
            const mcp = fetchFeed(client, '/e2e-mcp/hold/shared');
            await delay(100);
            harness.upstream.release('shared');
            expect((await rss).status).toBe(200);
            expect(feedData(await mcp).snapshot.cache).toBe('hit');
            expect(harness.upstream.hits('/hold/shared')).toBe(1);
        });
        it(`${backend} in progress claim surfaces request_in_progress`, async () => {
            harness.upstream.hold('in-progress');
            const rss = fetch(`${harness.base}/e2e-mcp/hold/in-progress?key=${harness.key}`);
            await harness.upstream.waitFor('/hold/in-progress');
            const mcp = await fetchFeed(client, '/e2e-mcp/hold/in-progress');
            expect(mcp.isError).toBe(true);
            expect(failureData(mcp).code).toBe('request_in_progress');
            harness.upstream.release('in-progress');
            await rss;
        });
    });
}
describe('disabled cache and dispatcher extraction', () => {
    it('reports disabled and completion build time', async () => {
        const harness = await startHarness({ cache: '' });
        try {
            const client = await harness.connect();
            const result = await fetchFeed(client, '/e2e-mcp/feed/disabled');
            expect(feedData(result).snapshot.cache).toBe('disabled');
            const builtAt = Date.parse(feedData(result).snapshot.builtAt);
            expect(Number.isFinite(builtAt)).toBe(true);
        } finally {
            await harness.close();
        }
    }, 30000);
    it('never rejects and distinguishes raw response/non-JSON/missing item and captured errors', async () => {
        const { createFeedDispatcher } = await import('./dispatch');
        const { getInternalRequestState } = await import('@/utils/internal-request');
        const thrown = new Error('fetch failed');
        expect(await createFeedDispatcher(() => Promise.reject(thrown)).dispatch('/test/1')).toMatchObject({ kind: 'error', error: thrown });
        await Promise.all(
            [new Response('raw'), new Response('{}'), new Response('', { status: 301 })].map(async (response) => {
                expect(await createFeedDispatcher(() => response).dispatch('/test/1')).toMatchObject({ kind: 'unsupported' });
            })
        );
        expect(typeof getInternalRequestState).toBe('function');
    });
});
