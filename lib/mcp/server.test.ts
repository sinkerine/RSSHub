import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Harness } from './test-harness';
import { delay, expectHttpAbort, failureData, rawCall, search, startHarness } from './test-harness';

describe.each([false, true])('MCP admission modern=%s', (modern) => {
    let harness: Harness;
    let client;
    beforeAll(async () => {
        harness = await startHarness({ timeout: 1, backend: 'third-party' });
        client = await harness.connect(modern);
    }, 30000);
    afterAll(async () => {
        await harness?.close();
    });
    it('capacity: saturated queue, FIFO, throw releases slot and recovery', async () => {
        harness.upstream.hold('capacity');
        const a = search(client, 'capacity');
        await harness.upstream.waitFor('capacity');
        const b = search(client, 'queued');
        await delay(50);
        const at = performance.now();
        const c = await search(client, 'rejected');
        expect(failureData(c)).toMatchObject({ code: 'capacity_exceeded', retryable: true });
        expect(performance.now() - at).toBeLessThan(1000);
        expect(harness.upstream.hits('rejected')).toBe(0);
        harness.upstream.release('capacity');
        expect((await a).isError).not.toBe(true);
        expect((await b).isError).not.toBe(true);
        harness.upstream.fail('upstream', 500);
        expect((await search(client, 'upstream')).isError).toBe(true);
        expect((await search(client, 'rejected')).isError).not.toBe(true);
    });
    it('timeout: queued never runs and running holds slot without result cache', async () => {
        harness.upstream.hold('timeout');
        const a = search(client, 'timeout');
        await harness.upstream.waitFor('timeout');
        const b = search(client, 'expired');
        expect(failureData(await a)).toMatchObject({ code: 'timeout', phase: 'running' });
        expect(failureData(await b)).toMatchObject({ code: 'timeout', phase: 'queued' });
        const next = search(client, 'after-timeout');
        await delay(100);
        expect(harness.upstream.hits('after-timeout')).toBe(0);
        harness.upstream.release('timeout');
        expect((await next).isError).not.toBe(true);
        expect((await search(client, 'timeout')).isError).not.toBe(true);
        expect(harness.upstream.hits('timeout')).toBe(2);
        expect(harness.upstream.hits('expired')).toBe(0);
    });
    it('cancel: HTTP abort removes queued task and running abort keeps slot', async () => {
        harness.upstream.hold('cancel');
        const controllerRunning = new AbortController();
        const running = expectHttpAbort(rawCall(harness.base, 'cancel', controllerRunning.signal));
        await harness.upstream.waitFor('cancel');
        const controller = new AbortController();
        const queued = expectHttpAbort(rawCall(harness.base, 'aborted', controller.signal));
        await delay(50);
        controller.abort();
        await queued;
        await delay(50);
        controllerRunning.abort();
        await running;
        await delay(50);
        const next = search(client, 'after-abort');
        await delay(50);
        expect(harness.upstream.hits('after-abort')).toBe(0);
        harness.upstream.release('cancel');
        expect((await next).isError).not.toBe(true);
        expect(harness.upstream.hits('aborted')).toBe(0);
    });
});
