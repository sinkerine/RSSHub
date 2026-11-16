import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type * as Undici from 'undici';
import { expect, vi } from 'vitest';
import { z } from 'zod';

import { startTwitterFixtureUpstream } from '../../scripts/e2e/fixture-upstream.mjs';

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startHarness(
    options: { cache?: string; timeout?: number; origins?: string; tools?: string; backend?: 'none' | 'third-party' | 'web' | 'developer'; maxResponseBytes?: number; enabled?: boolean; accessKey?: string } = {}
) {
    vi.resetModules();
    const upstream = await startTwitterFixtureUpstream();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rsshub-mcp-test-'));
    await copyFile(new URL('../../scripts/e2e/fixtures/e2e-smoke.mjs', import.meta.url), path.join(directory, 'e2e-smoke.mjs'));
    const key = options.accessKey ?? randomBytes(20).toString('hex');
    vi.stubEnv('USER_ROUTES_PATH', directory);
    vi.stubEnv('TWITTER_THIRD_PARTY_API', options.backend === 'third-party' ? upstream.url : undefined);
    vi.stubEnv('TWITTER_AUTH_TOKEN', options.backend === 'web' ? 'synthetic-auth-token' : undefined);
    vi.stubEnv('TWITTER_CONSUMER_KEY', options.backend === 'developer' ? 'synthetic-consumer-key' : undefined);
    vi.stubEnv('TWITTER_CONSUMER_SECRET', options.backend === 'developer' ? 'synthetic-consumer-secret' : undefined);
    if (options.tools !== undefined) {
        vi.stubEnv('MCP_TOOLS', options.tools);
    }
    vi.stubEnv('ACCESS_KEY', key);
    vi.stubEnv('MCP_ENABLE', options.enabled === false ? 'false' : 'true');
    vi.stubEnv('CACHE_TYPE', options.cache ?? 'memory');
    vi.stubEnv('REQUEST_RETRY', '0');
    vi.stubEnv('MCP_TIMEOUT', String(options.timeout ?? 10));
    vi.stubEnv('MCP_MAX_CONCURRENCY', '1');
    vi.stubEnv('MCP_MAX_QUEUE', '1');
    vi.stubEnv('MCP_MAX_RESPONSE_BYTES', String(options.maxResponseBytes ?? 262144));
    vi.stubEnv('MCP_ALLOWED_ORIGINS', options.origins ?? 'https://allowed.example');
    const { default: app } = await import('@/app');
    const { default: cache } = await import('@/utils/cache');
    await cache.set('twitter:gql-query-ids', JSON.stringify((await import('@/routes/twitter/api/web-api/gql-id-resolver')).fallbackIds), 3600);
    if (options.backend === 'web') {
        const { CookieJar } = await import('tough-cookie');
        const jar = new CookieJar();
        jar.setCookieSync('auth_token=synthetic-auth-token', 'https://x.com');
        jar.setCookieSync('ct0=synthetic-csrf-token', 'https://x.com');
        await cache.set('twitter:cookie:synthetic-auth-token', JSON.stringify(jar.serializeSync()), 3600);
    }
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
        cache,
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
export const search = (client: Client, query: string, args = {}) => client.callTool({ name: 'twitter_search', arguments: { query, ...args } });
export function rawCall(base: string, query: string, signal?: AbortSignal) {
    return fetch(`${base}/mcp`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'twitter_search', arguments: { query } } }),
    });
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

export async function installWebTransport() {
    const { readFile } = await import('node:fs/promises');
    const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../../scripts/e2e/fixtures/twitter-graphql/${name}.json`, import.meta.url), 'utf8'));
    const user = await fixture('test-user');
    const state = { detail: await fixture('tweet-detail'), requests: [] as Array<{ path: string; variables: Record<string, unknown> }> };
    vi.doMock('undici', async (importOriginal) => {
        const original = await importOriginal<typeof Undici>();
        const fetch: typeof original.fetch = (input, init) => {
            const url = new URL(typeof input === 'string' ? input : 'href' in input ? input.href : input.url);
            if (url.hostname === '127.0.0.1') {
                return original.fetch(input, init);
            }
            const operation = url.pathname.split('/').at(-1);
            state.requests.push({ path: url.pathname, variables: JSON.parse(url.searchParams.get('variables') || '{}') });
            if (url.hostname !== 'x.com' || !['UserByScreenName', 'UserByRestId', 'TweetDetail'].includes(operation || '')) {
                throw new Error(`Unexpected transport: ${url.origin}${url.pathname}`);
            }
            return Promise.resolve(original.Response.json(operation === 'TweetDetail' ? state.detail : user));
        };
        return { ...original, fetch, default: { ...original.default, fetch } };
    });
    return state;
}

export async function installDeveloperTransport() {
    const { readFile } = await import('node:fs/promises');
    const payload = JSON.parse(await readFile(new URL('../../scripts/e2e/fixtures/twitter-graphql/developer-page.json', import.meta.url), 'utf8'));
    const state = { payload, requests: [] as Array<{ path: string; variables: Record<string, unknown> }> };
    const get = (path: string, variables: Record<string, unknown>) => {
        state.requests.push({ path, variables });
        return Promise.resolve(path.startsWith('tweets/') && path !== 'tweets/search/recent' ? { ...state.payload, data: state.payload.data[0] } : state.payload);
    };
    const lookup = (name: string, variables: Record<string, unknown>) => {
        state.requests.push({ path: `lookup/${name}`, variables });
        return Promise.resolve({ data: payload.includes.users[0] });
    };
    vi.doMock('twitter-api-v2', () => ({
        TwitterApi: class {
            readOnly = { v2: { get, userByUsername: lookup, user: lookup }, appLogin: () => Promise.resolve(this.readOnly) };
        },
    }));
    return state;
}
