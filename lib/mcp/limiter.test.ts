import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapacityError, createLimiter, LimiterAbortError } from './limiter';

function deferred() {
    const { promise, resolve } = Promise.withResolvers<void>();
    return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
describe('limiter', () => {
    it('releases on success/throw', async () => {
        const limiter = createLimiter({ maxConcurrency: 1, maxQueue: 1 });
        expect(await limiter.run(() => Promise.resolve(3), new AbortController().signal)).toBe(3);
        await expect(limiter.run(() => Promise.reject(new Error('boom')), new AbortController().signal)).rejects.toThrow('boom');
        expect(limiter.stats().active).toBe(0);
    });
    it('fifo and rejects when full without running rejected tasks', async () => {
        const limiter = createLimiter({ maxConcurrency: 1, maxQueue: 2 });
        const hold = deferred();
        const order: number[] = [];
        const signal = new AbortController().signal;
        const a = limiter.run(async () => {
            order.push(1);
            await hold.promise;
        }, signal);
        const b = limiter.run(() => {
            order.push(2);
            return Promise.resolve();
        }, signal);
        const c = limiter.run(() => {
            order.push(3);
            return Promise.resolve();
        }, signal);
        const rejected = vi.fn();
        await expect(limiter.run(rejected, signal)).rejects.toBeInstanceOf(CapacityError);
        expect(rejected).not.toHaveBeenCalled();
        expect(limiter.stats()).toMatchObject({ active: 1, queued: 2 });
        hold.resolve();
        await Promise.all([a, b, c]);
        expect(order).toEqual([1, 2, 3]);
    });
    it('abort queued removes it and already aborted never starts', async () => {
        const limiter = createLimiter({ maxConcurrency: 1, maxQueue: 1 });
        const hold = deferred();
        const controller = new AbortController();
        const task = vi.fn();
        const a = limiter.run(() => hold.promise, new AbortController().signal);
        const b = limiter.run(task, controller.signal);
        controller.abort('client');
        await expect(b).rejects.toMatchObject({ name: 'McpLimiterAbortError', phase: 'queued', reason: 'client' });
        await expect(limiter.run(task, controller.signal)).rejects.toBeInstanceOf(LimiterAbortError);
        expect(limiter.stats().queued).toBe(0);
        expect(task).not.toHaveBeenCalled();
        hold.resolve();
        await a;
    });
    it('timeout queued never starts and abort running keeps slot until rejection settles', async () => {
        vi.useFakeTimers();
        const limiter = createLimiter({ maxConcurrency: 1, maxQueue: 1 });
        const hold = deferred();
        const running = new AbortController();
        const queued = new AbortController();
        const a = limiter.run(async () => {
            await hold.promise;
            throw new Error('late');
        }, running.signal);
        const task = vi.fn();
        const b = limiter.run(task, queued.signal);
        running.abort(new DOMException('Timeout', 'TimeoutError'));
        queued.abort(new DOMException('Timeout', 'TimeoutError'));
        await expect(a).rejects.toMatchObject({ phase: 'running' });
        await expect(b).rejects.toMatchObject({ phase: 'queued' });
        expect(task).not.toHaveBeenCalled();
        expect(limiter.stats().active).toBe(1);
        const next = limiter.run(() => Promise.resolve(5), new AbortController().signal);
        expect(limiter.stats().queued).toBe(1);
        hold.resolve();
        expect(await next).toBe(5);
        expect(limiter.stats().active).toBe(0);
    });
});
