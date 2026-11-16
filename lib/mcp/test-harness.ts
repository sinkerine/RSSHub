import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod';

import { startFixtureUpstream } from '../../scripts/e2e/fixture-upstream.mjs';
import { fetchFeedOutputSchema } from './result';

export const fixturePatterns = ['/feed/:id', '/hold/:id', '/fail/:kind', '/empty', '/empty-ok', '/raw'].map((p) => `/e2e-mcp${p}`);
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startHarness(options: { cache?: string; timeout?: number; origins?: string; routes?: string; enabled?: boolean; accessKey?: string } = {}) {
    vi.resetModules();
    const upstream = await startFixtureUpstream();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rsshub-mcp-test-'));
    await copyFile(new URL('../../scripts/e2e/fixtures/e2e-mcp.mjs', import.meta.url), path.join(directory, 'e2e-mcp.mjs'));
    const key = options.accessKey ?? randomBytes(20).toString('hex');
    vi.stubEnv('USER_ROUTES_PATH', directory);
    vi.stubEnv('E2E_MCP_UPSTREAM', upstream.url);
    vi.stubEnv('ACCESS_KEY', key);
    vi.stubEnv('MCP_ENABLE', options.enabled === false ? 'false' : 'true');
    vi.stubEnv('CACHE_TYPE', options.cache ?? 'memory');
    vi.stubEnv('MCP_TIMEOUT', String(options.timeout ?? 10));
    vi.stubEnv('MCP_MAX_CONCURRENCY', '1');
    vi.stubEnv('MCP_MAX_QUEUE', '1');
    vi.stubEnv('MCP_MAX_ITEMS', '10');
    vi.stubEnv('MCP_MAX_RESPONSE_BYTES', '16384');
    vi.stubEnv('MCP_ALLOWED_ORIGINS', options.origins ?? 'https://allowed.example');
    const { DEFAULT_MCP_ROUTES } = await import('@/config');
    vi.stubEnv('MCP_ROUTES', options.routes ?? [...(DEFAULT_MCP_ROUTES || []), ...fixturePatterns, '/test/:id/:params?'].join(','));
    // Config was loaded to obtain defaults; reload after setting the allowlist.
    vi.resetModules();
    const { default: app } = await import('@/app');
    const { default: cache } = await import('@/utils/cache');
    const redis = cache.clients.redisClient;
    if (redis) {
        if (redis.status !== 'ready') {
            await new Promise((resolve) => redis.once('ready', resolve));
        }
        await redis.flushdb();
    }
    const http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => http.once('listening', resolve));
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const clients: Client[] = [];
    const bodies: string[] = [];
    async function connect(modern = false) {
        const client = new Client({ name: 'rsshub-tests', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
        clients.push(client);
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
                fetch: async (url, init) => {
                    const response = await fetch(url, init);
                    bodies.push(await response.clone().text());
                    return response;
                },
            })
        );
        return client;
    }
    return {
        app,
        base,
        key,
        upstream,
        connect,
        bodies,
        async close() {
            // Release held routes before closing HTTP and cache connections.
            await upstream.close();
            await Promise.all(clients.map((client) => client.close()));
            if ('closeAllConnections' in http) {
                http.closeAllConnections();
            }
            await new Promise<void>((resolve) => http.close(() => resolve()));
            await redis?.quit();
            await rm(directory, { recursive: true, force: true });
            vi.unstubAllEnvs();
        },
    };
}
export type Harness = Awaited<ReturnType<typeof startHarness>>;
export const fetchFeed = (client: Client, path: string, args = {}) => client.callTool({ name: 'fetch_feed', arguments: { path, ...args } });
export function rawCall(base: string, path: string, signal?: AbortSignal) {
    return fetch(`${base}/mcp`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'fetch_feed', arguments: { path } } }),
    });
}

export function feedData(result: CallToolResult) {
    return fetchFeedOutputSchema.parse(result.structuredContent);
}
export function failureData(result: CallToolResult) {
    return z.object({ code: z.string(), retryable: z.boolean(), message: z.string(), phase: z.enum(['queued', 'running']).optional() }).parse((result.structuredContent as { error: unknown }).error);
}
export function textContent(result: CallToolResult) {
    const block = result.content[0];
    if (block.type !== 'text') {
        throw new Error('Expected text content');
    }
    return block.text;
}

export async function expectHttpAbort(pending: Promise<Response>) {
    try {
        const response = await pending;
        await response.text();
        throw new Error('Expected HTTP request to abort');
    } catch (error) {
        expect(error).toMatchObject({ name: 'AbortError' });
    }
}
