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
    it('user-route feeds are byte-identical with MCP disabled/enabled, including ETag and ACCESS_KEY', async () => {
        const { startHarness } = await import('@/mcp/test-harness');
        const snapshots: unknown[] = [];
        const pathname = '/e2e-smoke/feed';
        for (const enabled of [false, true]) {
            const harness = await startHarness({ enabled, accessKey: 'fixture-feed-comparison-key' });
            try {
                const responses: unknown[] = [];
                for (const format of ['rss', 'json']) {
                    const suffix = format === 'json' ? '?format=json' : '';
                    expect((await harness.app.request(pathname + suffix)).status).toBe(403);
                    for (const credential of [`key=${harness.key}`, `code=${md5(pathname + harness.key)}`]) {
                        const response = await harness.app.request(pathname + suffix + (suffix ? '&' : '?') + credential);
                        expect(response.status).toBe(200);
                        const body = await response.text();
                        expect(body).toContain('Smoke test article');
                        responses.push({ body: body.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, '<lastBuildDate>[build timestamp]</lastBuildDate>'), etag: response.headers.get('etag') });
                    }
                }
                snapshots.push(responses);
            } finally {
                await harness.close();
                vi.resetModules();
            }
        }
        expect(snapshots[1]).toEqual(snapshots[0]);
    }, 30000);
    it('uses the request Host for feed self links so isolated server ports can share a canonical comparison URL', async () => {
        const { startHarness } = await import('@/mcp/test-harness');
        const harness = await startHarness();
        try {
            const { get } = await import('node:http');
            const { text } = await import('node:stream/consumers');
            const body = await new Promise<string>((resolve, reject) => {
                get(`${harness.base}/e2e-smoke/feed?key=${harness.key}`, { headers: { host: 'rsshub-fixture.example' } }, (response) => {
                    expect(response.statusCode).toBe(200);
                    void text(response).then(resolve).catch(reject);
                }).once('error', reject);
            });
            expect(body).toContain('http://rsshub-fixture.example/e2e-smoke/feed?key=');
        } finally {
            await harness.close();
        }
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
