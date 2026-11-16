import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Harness } from './test-harness';
import { delay, expectHttpAbort, failureData, feedData, fetchFeed, rawCall, startHarness } from './test-harness';

describe.each([false, true])('MCP admission modern=%s', (modern) => {
    let harness: Harness;
    let client;
    beforeAll(async () => {
        harness = await startHarness({ timeout: 1 });
        client = await harness.connect(modern);
    }, 30000);
    afterAll(async () => {
        await harness?.close();
    });
    it('capacity: saturated queue, FIFO, throw releases slot and recovery', async () => {
        harness.upstream.hold('capacity');
        const a = fetchFeed(client, '/e2e-mcp/hold/capacity');
        await harness.upstream.waitFor('/hold/capacity');
        const b = fetchFeed(client, '/e2e-mcp/feed/queued');
        await delay(50);
        const at = performance.now();
        const c = await fetchFeed(client, '/e2e-mcp/feed/rejected');
        expect(failureData(c)).toMatchObject({ code: 'capacity_exceeded', retryable: true });
        expect(performance.now() - at).toBeLessThan(1000);
        expect(harness.upstream.hits('/feed/rejected')).toBe(0);
        harness.upstream.release('capacity');
        expect((await a).isError).not.toBe(true);
        expect((await b).isError).not.toBe(true);
        expect((await fetchFeed(client, '/e2e-mcp/fail/upstream')).isError).toBe(true);
        expect((await fetchFeed(client, '/e2e-mcp/feed/rejected')).isError).not.toBe(true);
    });
    it('timeout: queued never runs, running keeps slot, timeout populates cache', async () => {
        harness.upstream.hold('timeout');
        const a = fetchFeed(client, '/e2e-mcp/hold/timeout');
        await harness.upstream.waitFor('/hold/timeout');
        const b = fetchFeed(client, '/e2e-mcp/feed/expired');
        expect(failureData(await a)).toMatchObject({ code: 'timeout', phase: 'running' });
        expect(failureData(await b)).toMatchObject({ code: 'timeout', phase: 'queued' });
        const next = fetchFeed(client, '/e2e-mcp/feed/after-timeout');
        await delay(100);
        expect(harness.upstream.hits('/feed/after-timeout')).toBe(0);
        harness.upstream.release('timeout');
        expect((await next).isError).not.toBe(true);
        expect(feedData(await fetchFeed(client, '/e2e-mcp/hold/timeout')).snapshot.cache).toBe('hit');
        expect(harness.upstream.hits('/hold/timeout')).toBe(1);
        expect(harness.upstream.hits('/feed/expired')).toBe(0);
    });
    it('cancel: HTTP abort removes queued task and running abort keeps slot', async () => {
        harness.upstream.hold('cancel');
        const controllerRunning = new AbortController();
        const running = expectHttpAbort(rawCall(harness.base, '/e2e-mcp/hold/cancel', controllerRunning.signal));
        await harness.upstream.waitFor('/hold/cancel');
        const controller = new AbortController();
        const queued = expectHttpAbort(rawCall(harness.base, '/e2e-mcp/feed/aborted', controller.signal));
        await delay(50);
        controller.abort();
        await queued;
        await delay(50);
        controllerRunning.abort();
        await running;
        await delay(50);
        const next = fetchFeed(client, '/e2e-mcp/feed/after-abort');
        await delay(50);
        expect(harness.upstream.hits('/feed/after-abort')).toBe(0);
        harness.upstream.release('cancel');
        expect((await next).isError).not.toBe(true);
        expect(harness.upstream.hits('/feed/aborted')).toBe(0);
    });
});
