import { describe, expect, it, vi } from 'vitest';

import { config } from '@/config';

import { runTool } from './executor';
import { createLimiter } from './limiter';

const deps = () => ({ mcpConfig: { ...config.mcp, timeout: 1 }, limiter: createLimiter({ maxConcurrency: 1, maxQueue: 1 }), redact: (text: string) => text.replaceAll('synthetic-secret', '[redacted]'), log: vi.fn() });
const signal = () => new AbortController().signal;
const result = () => ({ output: { ok: true }, trim: () => false });
describe('MCP executor', () => {
    it('returns identical structured/text JSON and logs no arguments', async () => {
        const d = deps();
        const output = await runTool('twitter_search', d, [signal()], () => Promise.resolve(result()));
        expect(JSON.parse((output.content[0] as { text: string }).text)).toEqual(output.structuredContent);
        expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/^mcp twitter_search ok \d+ms$/));
    });
    it('runs cursor validation before admission and before source', async () => {
        const d = deps();
        const work = vi.fn();
        const admission = vi.spyOn(d.limiter, 'run');
        const { InvalidCursorError } = await import('./cursor');
        const output = await runTool('twitter_search', d, [signal()], work, () => {
            throw new InvalidCursorError();
        });
        expect(output.structuredContent).toMatchObject({ error: { code: 'invalid_cursor', retryable: false } });
        expect(admission).not.toHaveBeenCalled();
        expect(work).not.toHaveBeenCalled();
    });
    it('redacts then clips error messages and never emits exception stacks', async () => {
        const output = await runTool('twitter_search', deps(), [signal()], () => Promise.reject(new Error('synthetic-secret ' + 'x'.repeat(500))));
        const error = (output.structuredContent as { error: { message: string } }).error;
        expect(error.message).toContain('[redacted]');
        expect(error.message.length).toBeLessThanOrEqual(300);
        expect(JSON.stringify(output)).not.toMatch(/synthetic-secret|stack/);
    });
    it('drops trailing posts until within byte bound and errors if focal cannot fit', async () => {
        const d = deps();
        d.mcpConfig.maxResponseBytes = 100;
        const posts = ['a'.repeat(70), 'b'.repeat(70)];
        const output = await runTool('twitter_search', d, [signal()], () => Promise.resolve({ output: { posts }, trim: () => Boolean(posts.pop()) }));
        expect(Buffer.byteLength(JSON.stringify(output.structuredContent))).toBeLessThanOrEqual(100);
        expect(posts).toHaveLength(1);
        const oversized = await runTool('twitter_get_tweet', d, [signal()], () => Promise.resolve({ output: { tweet: 'x'.repeat(101) }, trim: () => false }));
        expect(oversized.structuredContent).toMatchObject({ error: { code: 'internal_error' } });
    });
});
