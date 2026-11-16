/* eslint-disable no-await-in-loop -- Sequential requests verify state, paging and source-hit boundaries. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Harness } from './test-harness';
import { installDeveloperTransport, installWebTransport, startHarness } from './test-harness';

let harness: Harness;
beforeAll(async () => {
    harness = await startHarness();
}, 30000);
afterAll(async () => {
    await harness?.close();
});

describe.each([false, true])('Twitter MCP catalog modern=%s', (modern) => {
    it('exposes exactly the three typed Twitter tools and rejects removed tools', async () => {
        const client = await harness.connect(modern);
        const tools = (await client.listTools()).tools;
        expect(tools.map((tool) => tool.name).toSorted()).toEqual(['twitter_get_tweet', 'twitter_search', 'twitter_user_tweets']);
        expect(tools).toMatchSnapshot();
        for (const tool of tools) {
            expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
            expect(tool.inputSchema.additionalProperties).toBe(false);
            expect(tool.outputSchema).toBeDefined();
        }
        for (const name of ['fetch_feed', 'search_routes']) {
            await expect(client.callTool({ name, arguments: {} })).rejects.toThrow(`Tool ${name} not found`);
        }
    });
    it('new tools reach source configuration errors through the real endpoint', async () => {
        const client = await harness.connect(modern);
        const result = await client.callTool({ name: 'twitter_get_tweet', arguments: { user: 'rsshub_fixture', tweetId: '900000000000000101' } });
        expect(result.structuredContent).toMatchObject({ error: { code: 'source_config_missing', retryable: false } });
    });
});

describe.each([false, true])('Twitter strict schemas modern=%s', (modern) => {
    it('rejects invalid inputs before source with SDK text-only errors', async () => {
        const client = await harness.connect(modern);
        for (const [name, arguments_] of [
            ['twitter_search', { query: '' }],
            ['twitter_search', { query: 'q'.repeat(513) }],
            ['twitter_search', { query: 'q', limit: 0 }],
            ['twitter_search', { query: 'q', limit: 21 }],
            ['twitter_search', { query: 'q', offset: 1 }],
            ['twitter_user_tweets', { user: 'bad/user' }],
            ['twitter_user_tweets', { user: '+abc' }],
            ['twitter_user_tweets', { user: 'valid', onlyMedia: true }],
            ['twitter_get_tweet', { user: 'valid', tweetId: 'abc' }],
            ['twitter_get_tweet', { user: 'valid', tweetId: '123', cursor: 'v1.e30' }],
        ] as Array<[string, Record<string, unknown>]>) {
            const result = await client.callTool({ name, arguments: arguments_ });
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toBeUndefined();
            expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^Input validation error/) });
        }
        expect(harness.upstream.hits()).toBe(0);
    });
});

it.each(['twitter_search', '', ' unknown, twitter_user_tweets, unknown '])(
    'exposes only configured tools %s and warns on ignored configuration',
    async (tools) => {
        const local = await startHarness({ tools });
        try {
            const client = await local.connect();
            expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(tools.includes('twitter_user_tweets') ? ['twitter_user_tweets'] : tools === 'twitter_search' ? ['twitter_search'] : []);
            const { createMcpEndpoint } = await import('./index');
            const logger = (await import('@/utils/logger')).default;
            const spy = vi.spyOn(logger, 'warn');
            vi.stubEnv('MCP_ROUTES', '/test/:id');
            vi.stubEnv('MCP_MAX_ITEMS', '100');
            createMcpEndpoint();
            expect(spy).toHaveBeenCalledWith(expect.stringContaining('MCP_ROUTES and MCP_MAX_ITEMS are ignored'));
            expect(spy).toHaveBeenCalledWith(expect.stringContaining('backend is not configured'));
            if (tools.includes('unknown')) {
                expect(spy.mock.calls.filter(([line]) => String(line).includes('unknown tool unknown'))).toHaveLength(1);
            }
            spy.mockRestore();
        } finally {
            await local.close();
        }
    },
    30000
);

describe.each([false, true])('get_tweet real adapter modern=%s', (modern) => {
    it('web: real HTTP entry reaches TweetDetail transport and normalizes focal/thread, limit and absent focal', async () => {
        const transport = await installWebTransport();
        const local = await startHarness({ backend: 'web' });
        try {
            const client = await local.connect(modern);
            const call = () => client.callTool({ name: 'twitter_get_tweet', arguments: { user: '@rsshub_test', tweetId: '900000000000000123', limit: 1 } });
            const result = await call();
            expect(result.isError, JSON.stringify(result)).not.toBe(true);
            const { getTweetOutputSchema } = await import('./twitter-tools');
            const output = getTweetOutputSchema.parse(result.structuredContent);
            expect(output.tweet).toMatchObject({ id: '900000000000000123', text: 'Synthetic page post 123 & https://example.com/docs?q=fixture', author: { username: 'rsshub_test' } });
            expect(output.thread).toHaveLength(1);
            expect(output.returnedCount).toBe(1);
            expect(output.sourceCount).toBe(4);
            expect(output.truncated.items).toBe(true);
            expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(output);
            const { TWEET_DETAIL_PARAMS } = await import('@/routes/twitter/utils');
            const detail = transport.requests.find((request) => request.path.endsWith('/TweetDetail'))!;
            expect(detail.variables).toEqual({
                focalTweetId: '900000000000000123',
                ...TWEET_DETAIL_PARAMS,
                includeHasBirdwatchNotes: false,
                includePromotedContent: false,
                withBirdwatchNotes: false,
                withVoice: false,
                userId: '900000000000000002',
            });
            transport.detail.data.threaded_conversation_with_injections_v2.instructions[0].entries.shift();
            expect((await call()).structuredContent).toMatchObject({ error: { code: 'not_found', retryable: false } });
            expect(transport.requests.map((request) => request.path.split('/').at(-1))).toEqual(['UserByScreenName', 'TweetDetail', 'TweetDetail']);
        } finally {
            await local.close();
            vi.doUnmock('undici');
        }
    }, 30000);
    it('developer: real HTTP entry reaches tweets/id transport; focal with empty thread and absent focal', async () => {
        const transport = await installDeveloperTransport();
        const local = await startHarness({ backend: 'developer' });
        try {
            const client = await local.connect(modern);
            const call = () => client.callTool({ name: 'twitter_get_tweet', arguments: { user: '+900000000000000002', tweetId: '900000000000000123' } });
            const result = await call();
            expect(result.isError, JSON.stringify(result)).not.toBe(true);
            const { getTweetOutputSchema } = await import('./twitter-tools');
            expect(getTweetOutputSchema.parse(result.structuredContent)).toMatchObject({ tweet: { id: '900000000000000123', text: 'Developer synthetic post & text', metrics: { likes: 7 } }, thread: [], returnedCount: 0 });
            expect(transport.requests.map((request) => request.path)).toEqual(['lookup/900000000000000002', 'tweets/900000000000000123']);
            transport.payload.data = [];
            expect((await call()).structuredContent).toMatchObject({ error: { code: 'not_found' } });
        } finally {
            await local.close();
            vi.doUnmock('twitter-api-v2');
        }
    }, 30000);
});
