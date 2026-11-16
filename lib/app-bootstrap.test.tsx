/* eslint-disable no-await-in-loop -- These acceptance sequences share mutable server, queue or environment state. */
import { describe, expect, it, vi } from 'vitest';

import logger from '@/utils/logger';
import md5 from '@/utils/md5';

describe('app-bootstrap', () => {
    it('logs uncaught exceptions', async () => {
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const before = new Set(process.listeners('uncaughtException'));
        await import('@/app-bootstrap');
        const after = process.listeners('uncaughtException');
        const listener = after.find((fn) => !before.has(fn) && String(fn).includes('uncaughtException: '));

        expect(listener).toBeDefined();
        listener?.(new Error('boom'), 'uncaughtException');
        expect(errorSpy).toHaveBeenCalled();

        if (listener) {
            process.removeListener('uncaughtException', listener);
        }
        errorSpy.mockRestore();
    });
});

describe('MCP mounting', () => {
    it('mcp disabled never imports endpoint and preserves not-found bodies', async () => {
        vi.resetModules();
        vi.stubEnv('MCP_ENABLE', 'false');
        const factory = vi.fn(() => {
            throw new Error('must not load');
        });
        vi.doMock('@/mcp', factory);
        try {
            const { default: app } = await import('@/app');
            for (const method of ['GET', 'POST', 'DELETE']) {
                const response = await app.request('/mcp', { method });
                expect(response.status).toBe(404);
                expect(await response.text()).toContain('NotFoundError');
            }
            expect(factory).not.toHaveBeenCalled();
        } finally {
            vi.doUnmock('@/mcp');
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });
    it('mcp enabled logs unauthenticated warning and does not shadow /mcp/feed', async () => {
        vi.resetModules();
        vi.stubEnv('MCP_ENABLE', 'true');
        try {
            const log = (await import('@/utils/logger')).default;
            const warn = vi.spyOn(log, 'warn');
            const { default: app } = await import('@/app');
            expect(warn).toHaveBeenCalledWith('MCP endpoint mounted at /mcp without authentication; restrict access at the network or reverse proxy');
            expect((await app.request('/mcp', { method: 'GET' })).status).toBe(405);
            expect((await app.request('/mcp/feed', { method: 'POST' })).status).toBe(404);
            warn.mockRestore();
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });
    it('feeds for /e2e-mcp/feed/identical are byte-identical with MCP disabled/enabled, including ETag and ACCESS_KEY', async () => {
        const { startHarness } = await import('@/mcp/test-harness');
        const path = '/e2e-mcp/feed/identical';
        const accessKey = 'fixture-feed-comparison-key';
        const sourcePayloads: unknown[] = [];
        const snapshots: Array<Array<{ requestPath: string; bytes: Uint8Array; etag: string | null }>> = [];
        for (const enabled of [false, true]) {
            const harness = await startHarness({ enabled, accessKey });
            try {
                const source = await fetch(`${harness.upstream.url}/feed/identical`);
                expect(source.status).toBe(200);
                sourcePayloads.push(await source.json());
                const responses: Array<{ requestPath: string; bytes: Uint8Array; etag: string | null }> = [];
                for (const format of ['rss', 'json']) {
                    const suffix = format === 'json' ? '?format=json' : '';
                    const sourceHits = harness.upstream.hits('/feed/identical');
                    expect((await harness.app.request(path + suffix)).status).toBe(403);
                    expect(harness.upstream.hits('/feed/identical')).toBe(sourceHits);
                    for (const credential of [`key=${accessKey}`, `code=${md5(path + accessKey)}`]) {
                        const requestPath = path + suffix + (suffix ? '&' : '?') + credential;
                        const response = await harness.app.request(requestPath);
                        expect(response.status).toBe(200);
                        expect(response.headers.get('content-type')).toContain(format === 'json' ? 'application/feed+json' : 'application/xml');
                        const etag = response.headers.get('etag');
                        expect(etag).toBeTruthy();
                        const body = await response.text();
                        if (format === 'rss') {
                            expect(body).toContain('RSSHub MCP fixture');
                            expect(body.match(/<item>/g)).toHaveLength(3);
                        } else {
                            expect(JSON.parse(body)).toMatchObject({ title: 'RSSHub MCP fixture', items: [{ title: 'identical article 0' }, { title: 'identical article 1' }, { title: 'identical article 2' }] });
                        }
                        // JSON Feed contains only source dates; exclude just the RSS build timestamp.
                        const normalized = format === 'rss' ? body.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, '<lastBuildDate>[build timestamp]</lastBuildDate>') : body;
                        responses.push({ requestPath, bytes: new TextEncoder().encode(normalized), etag });
                    }
                }
                // One source-payload observation plus one uncached request per feed format.
                expect(harness.upstream.hits('/feed/identical')).toBe(3);
                snapshots.push(responses);
            } finally {
                await harness.close();
                vi.resetModules();
            }
        }
        expect(sourcePayloads[1]).toEqual(sourcePayloads[0]);
        expect(snapshots[1]).toEqual(snapshots[0]);
    }, 30000);
    it('feeds identical with mcp enabled, including ETag', async () => {
        const results: Array<{ text: string; etag: string | null }> = [];
        for (const enable of ['false', 'true']) {
            vi.resetModules();
            vi.stubEnv('MCP_ENABLE', enable);
            const { default: app } = await import('@/app');
            for (const format of ['', '?format=json']) {
                const response = await app.request('/test/1' + format);
                results.push({ text: (await response.text()).replaceAll(/<lastBuildDate>.*?<\/lastBuildDate>|"(?:lastBuildDate|updated)":"[^"]*"/g, ''), etag: response.headers.get('etag') });
            }
        }
        vi.unstubAllEnvs();
        vi.resetModules();
        expect(results[0]).toEqual(results[2]);
        expect(results[1]).toEqual(results[3]);
    });
});
