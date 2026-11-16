/* eslint-disable no-await-in-loop -- These acceptance sequences share mutable server, queue or environment state. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Harness } from './test-harness';
import { startHarness } from './test-harness';

let harness: Harness;
beforeAll(async () => {
    harness = await startHarness();
}, 30000);
afterAll(async () => {
    await harness?.close();
});
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
            expect(spy.mock.calls.flat().join(' ')).not.toMatch(/mcp (?:twitter_search|twitter_user_tweets|twitter_get_tweet)/);
            factory.mockRestore();
            expect(spy.mock.calls.flat().join(' ')).not.toContain('neverLoggedDummy');
            expect(checkOrigin(new Request('http://localhost/mcp'), config.mcp)).toBeUndefined();
            expect(typeof createMcpEndpoint).toBe('function');
            spy.mockRestore();
        });
    });
    describe.each([false, true])('transport modern=%s', (modern) => {
        it('retains legacy SSE and modern JSON, 405 and body-size bounds', async () => {
            const client = await harness.connect(modern);
            expect(client.getServerVersion()?.name).toBe('rsshub');
            expect((await client.listTools()).tools).toHaveLength(3);
            for (const method of ['GET', 'DELETE']) {
                expect((await fetch(`${harness.base}/mcp`, { method })).status).toBe(405);
            }
            const oversized = await fetch(`${harness.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: ' '.repeat(65537) });
            expect(oversized.status).toBe(413);
            expect(harness.bodies.some((body) => (modern ? body.startsWith('{') : body.includes('data: ')))).toBe(true);
        });
    });
    it('has no RSS dispatch, catalog or private-symbol dependency', async () => {
        const { readFile } = await import('node:fs/promises');
        const files = ['index', 'server', 'executor', 'twitter-tools', 'twitter-source'];
        const sources = await Promise.all(files.map((name) => readFile(new URL(`${name}.ts`, import.meta.url), 'utf8')));
        expect(sources.join('\n')).not.toMatch(/internal-request|app\.fetch|magpie\/|from ['"]\.\/(?:dispatch|allowlist|catalog|result)['"]/);
    });
});
