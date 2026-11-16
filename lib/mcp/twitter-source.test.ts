/* eslint-disable no-await-in-loop -- Sequential requests verify state, paging and source-hit boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Harness } from './test-harness';
import { installDeveloperTransport, installWebTransport, search, startHarness } from './test-harness';

let harness: Harness | undefined;
afterEach(async () => {
    await harness?.close();
    harness = undefined;
    vi.doUnmock('twitter-api-v2');
    vi.doUnmock('undici');
});
const success = (result: any) => {
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent;
};

describe('real web adapter with synthetic transport', () => {
    it('reads fresh twice while retaining one user lookup; RSS cache neither satisfies nor is populated by MCP', async () => {
        harness = await startHarness({ backend: 'third-party' });
        const client = await harness.connect();
        const call = () => client.callTool({ name: 'twitter_user_tweets', arguments: { user: '@rsshub_test', limit: 5 } });
        success(await call());
        success(await call());
        expect(harness.upstream.hits('UserByScreenName')).toBe(1);
        expect(harness.upstream.hits('UserTweets')).toBe(2);
        const response = await harness.app.request(`/twitter/user/rsshub_test?key=${harness.key}`);
        expect(response.status).toBe(200);
        expect(harness.upstream.hits('UserTweets')).toBe(3);
        success(await call());
        expect(harness.upstream.hits('UserTweets')).toBe(4);
        expect((await harness.app.request(`/twitter/user/rsshub_test?key=${harness.key}`)).headers.get('RSSHub-Cache-Status')).toBe('HIT');
        expect(harness.upstream.hits('UserTweets')).toBe(4);
    });
    it('preserves RSS request variable order/cache key and bypasses result cache on page paths', async () => {
        harness = await startHarness({ backend: 'third-party' });
        const { default: api } = await import('@/routes/twitter/api');
        const { getTwitterUserCacheKey } = await import('@/routes/twitter/utils');
        await api.init();
        const spy = vi.spyOn(harness.cache, 'tryGet');
        await api.getUserTweets('rsshub_test', {});
        expect(spy.mock.calls.some(([key, , ttl, refresh]) => key === getTwitterUserCacheKey('900000000000000002', 'getUserTweets', {}) && ttl === 300 && refresh === false)).toBe(true);
        const original = harness.upstream.log().find((entry) => entry.operation === 'UserTweets')!;
        expect(JSON.stringify(original.variables)).toBe('{"count":20,"includePromotedContent":true,"withQuickPromoteEligibilityTweetFields":true,"withVoice":true,"withV2Timeline":true,"userId":"900000000000000002"}');
        spy.mockClear();
        await api.getUserTweetsPage('rsshub_test');
        expect(spy.mock.calls.map(([key]) => key)).toEqual(['twitter:web:userdata:v2:rsshub_test']);
        expect(harness.upstream.log().at(-1)?.variables).toEqual(original.variables);
        spy.mockRestore();
    });
    it('maps exact query/replies/retweet/user arguments and forwards upstream cursors', async () => {
        harness = await startHarness({ backend: 'third-party' });
        const client = await harness.connect();
        const query = '"quoted" #tag % / ? 中文';
        const output = success(await search(client, query, { limit: 5 }));
        expect(harness.upstream.log().at(-1)?.variables.rawQuery).toBe(query);
        expect(output.tweets).toHaveLength(5);
        const posts = success(await client.callTool({ name: 'twitter_user_tweets', arguments: { user: '+900000000000000002', includeReplies: true, includeRetweets: false, limit: 5 } }));
        expect(harness.upstream.hits('UserByRestId')).toBe(1);
        expect(harness.upstream.log().at(-1)?.operation).toBe('UserTweetsAndReplies');
        expect(posts.tweets.every((tweet) => !tweet.isRetweet)).toBe(true);
        expect(posts.tweets.some((tweet) => tweet.isReply)).toBe(true);
        expect(posts.user.username).toBe('rsshub_test');
        const { createTwitterSource } = await import('./twitter-source');
        const page = await createTwitterSource().search(query, { cursor: 'page-2' });
        expect(page.tweets).toHaveLength(3);
        expect(page.nextCursor).toBe('page-3');
        expect(Object.keys(harness.upstream.log().at(-1)!.variables).at(-1)).toBe('cursor');
    });
    it('walks real Bottom/TimelineReplaceEntry pages without loss with limit 5 and validates binding before source', async () => {
        harness = await startHarness({ backend: 'third-party' });
        const client = await harness.connect();
        const ids: string[] = [];
        let cursor: string | undefined;
        let first: string | undefined;
        for (let page = 0; page < 10; page++) {
            const result = success(await search(client, 'cursor-walk', { limit: 5, ...(cursor && { cursor }) }));
            ids.push(...result.tweets.map((tweet) => tweet.id));
            cursor = result.nextCursor;
            first ||= cursor;
            if (!cursor) {
                break;
            }
        }
        expect(ids).toHaveLength(23);
        expect(new Set(ids).size).toBe(23);
        expect(cursor).toBeUndefined();
        const before = harness.upstream.hits();
        for (const bad of [first!, 'v1.e30', 'v1.bm90LWpzb24']) {
            expect((await search(client, 'different-query', { cursor: bad })).structuredContent).toMatchObject({ error: { code: 'invalid_cursor' } });
        }
        expect(harness.upstream.hits()).toBe(before);
        const value = JSON.parse(Buffer.from(first!.slice(3), 'base64url').toString());
        value.c = 'edited-upstream';
        delete value.a;
        const edited = `v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
        const result = success(await search(client, 'cursor-walk', { cursor: edited }));
        expect(harness.upstream.log().at(-1)?.variables.cursor).toBe('edited-upstream');
        expect(result.tweets).toEqual([]);
        expect(result.nextCursor).toBeUndefined();
    });
    it('completes MCP while an identical RSS source request is held and vice versa', async () => {
        harness = await startHarness({ backend: 'third-party', timeout: 1 });
        const client = await harness.connect();
        const tag = '900000000000000002';
        harness.upstream.hold(tag, true);
        const rss = harness.app.request(`/twitter/user/rsshub_test?key=${harness.key}`);
        await harness.upstream.waitFor(tag);
        const pending = client.callTool({ name: 'twitter_user_tweets', arguments: { user: 'rsshub_test' } });
        await harness.upstream.waitFor(tag, 2);
        try {
            success(await pending);
        } finally {
            harness.upstream.release(tag);
        }
        expect((await rss).status).toBe(200);
        expect(harness.upstream.hits('UserTweets')).toBe(2);
        const other = '900000000000000001';
        harness.upstream.hold(other, true);
        const mcp = client.callTool({ name: 'twitter_user_tweets', arguments: { user: 'rsshub_fixture' } });
        await harness.upstream.waitFor(other);
        try {
            expect((await harness.app.request(`/twitter/user/rsshub_fixture?key=${harness.key}`)).status).toBe(200);
        } finally {
            harness.upstream.release(other);
        }
        success(await mcp);
    });
    it('rejects third-party-only detail before even cold query-ID discovery can touch X', async () => {
        const transport = await installWebTransport();
        harness = await startHarness({ backend: 'third-party' });
        await harness.cache.set('twitter:gql-query-ids', '', 3600);
        const client = await harness.connect();
        expect((await client.callTool({ name: 'twitter_get_tweet', arguments: { user: 'rsshub_test', tweetId: '123' } })).structuredContent).toMatchObject({ error: { code: 'source_config_missing' } });
        expect(transport.requests).toEqual([]);
        expect(harness.upstream.hits()).toBe(0);
    });
    it('reports third-party detail credential requirement, unknown user and real upstream 429', async () => {
        harness = await startHarness({ backend: 'third-party' });
        const client = await harness.connect();
        expect((await client.callTool({ name: 'twitter_get_tweet', arguments: { user: 'rsshub_test', tweetId: '123' } })).structuredContent).toMatchObject({ error: { code: 'source_config_missing' } });
        expect(harness.upstream.hits()).toBe(0);
        expect((await client.callTool({ name: 'twitter_user_tweets', arguments: { user: 'missing' } })).structuredContent).toMatchObject({ error: { code: 'invalid_parameter' } });
        harness.upstream.fail('rate', 429);
        expect((await search(client, 'rate')).structuredContent).toMatchObject({ error: { code: 'upstream_rate_limited', retryAfterSeconds: 120 } });
    });
});

describe('real developer adapter with twitter-api-v2 transport fixture', () => {
    it('normalizes developer repost, quote, reply, media and missing-user shapes through the actual adapter', async () => {
        const transport = await installDeveloperTransport();
        const template = transport.payload.data[0];
        transport.payload.data = [
            { ...template, id: '901', referenced_tweets: [{ type: 'retweeted', id: '700' }] },
            { ...template, id: '902', author_id: 'missing', created_at: 'invalid' },
        ];
        transport.payload.includes.users.push({ id: 'original', username: 'original_author', name: 'Original author' });
        transport.payload.includes.tweets = [
            {
                ...template,
                id: '700',
                author_id: 'original',
                text: 'Original &amp; https://t.co/link',
                entities: { urls: [{ url: 'https://t.co/link', expanded_url: 'https://example.com/post?q=keep' }], hashtags: [{ tag: 'fixture' }], mentions: [{ username: 'friend' }] },
                attachments: { media_keys: ['photo', 'video', 'gif'] },
                referenced_tweets: [
                    { type: 'quoted', id: '600' },
                    { type: 'replied_to', id: '500' },
                ],
            },
            { ...template, id: '600', author_id: 'original', text: 'Quoted &lt;text&gt;' },
            { ...template, id: '500', author_id: 'original', text: 'Parent' },
        ];
        transport.payload.includes.media = [
            { media_key: 'photo', type: 'photo', url: 'https://example.com/photo', width: 640, height: 480 },
            { media_key: 'video', type: 'video', preview_image_url: 'https://example.com/poster', variants: [{ content_type: 'video/mp4', bit_rate: 100, url: 'https://example.com/video.mp4' }] },
            { media_key: 'gif', type: 'animated_gif', preview_image_url: 'https://example.com/gif-poster', variants: [{ content_type: 'video/mp4', url: 'https://example.com/gif.mp4' }] },
        ];
        harness = await startHarness({ backend: 'developer' });
        const client = await harness.connect();
        const output = success(await search(client, 'developer-shapes'));
        expect(output.tweets[0]).toMatchObject({
            id: '700',
            isRetweet: true,
            retweetedBy: { username: 'rsshub_test' },
            author: { username: 'original_author' },
            isReply: true,
            isQuote: true,
            replyTo: { tweetId: '500' },
            quoted: { id: '600', text: 'Quoted <text>' },
            text: 'Original & https://example.com/post?q=keep',
            hashtags: ['fixture'],
            mentions: ['friend'],
        });
        expect(output.tweets[0].media.map((entry) => entry.type)).toEqual(['photo', 'video', 'animated_gif']);
        expect(output.tweets[1]).not.toHaveProperty('author');
        expect(output.tweets[1]).not.toHaveProperty('createdAt');
    });
    it('fails a page that cannot retain even one post within the byte bound instead of skipping it', async () => {
        const transport = await installDeveloperTransport();
        transport.payload.data[0].attachments = { media_keys: ['oversize'] };
        transport.payload.includes.media = [{ media_key: 'oversize', type: 'photo', url: 'https://example.com/' + 'x'.repeat(70000) }];
        harness = await startHarness({ backend: 'developer', maxResponseBytes: 65536 });
        const client = await harness.connect();
        expect((await search(client, 'oversize-single-post')).structuredContent).toMatchObject({ error: { code: 'internal_error' } });
    });
    it('bounds real normalized output bytes and resumes after the last retained upstream id', async () => {
        const transport = await installDeveloperTransport();
        const template = transport.payload.data[0];
        transport.payload.data = Array.from({ length: 20 }, (_, index) => ({ ...template, id: String(9000 - index), text: '🔥'.repeat(2000) }));
        harness = await startHarness({ backend: 'developer', maxResponseBytes: 65536 });
        const client = await harness.connect();
        const first = success(await search(client, 'byte-bound'));
        expect(first.truncated.bytes).toBe(true);
        expect(first.returnedCount).toBeGreaterThan(0);
        expect(first.returnedCount).toBeLessThan(20);
        expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(65536);
        const second = success(await search(client, 'byte-bound', { cursor: first.nextCursor }));
        expect(second.tweets[0].id).toBe(String(9000 - first.returnedCount));
        expect(first.tweets.every((tweet) => tweet.text.isWellFormed())).toBe(true);
    });
    it('forwards pagination tokens, skips result caches and snapshots, retains lookup, and preserves ordinary cached request', async () => {
        const transport = await installDeveloperTransport();
        harness = await startHarness({ backend: 'developer' });
        const { createTwitterSource } = await import('./twitter-source');
        const source = createTwitterSource();
        const cacheGet = vi.spyOn(harness.cache, 'get');
        const cacheSet = vi.spyOn(harness.cache, 'set');
        const first = await source.userTweets('rsshub_test', false);
        expect(first.nextCursor).toBe('developer-page-2');
        await source.userTweets('rsshub_test', false, { cursor: first.nextCursor });
        await source.search('exact % / ? 中文', { cursor: 'edited-developer' });
        expect(transport.requests.filter((request) => request.path.startsWith('lookup/'))).toHaveLength(1);
        expect(transport.requests[2].variables.pagination_token).toBe('developer-page-2');
        expect(transport.requests.at(-1)?.variables).toMatchObject({ query: 'exact % / ? 中文', next_token: 'edited-developer' });
        expect(cacheGet.mock.calls.flat().join(' ')).not.toMatch(/developer-timeline|twitter:search|:getUserTweets/);
        expect(cacheSet.mock.calls.flat().join(' ')).not.toMatch(/developer-timeline|twitter:search|:getUserTweets/);
        cacheGet.mockClear();
        cacheSet.mockClear();
        const { default: api } = await import('@/routes/twitter/api');
        await api.getUserTweets('rsshub_test', {});
        const rssRequest = transport.requests.at(-1)!;
        expect(rssRequest.variables).not.toHaveProperty('pagination_token');
        expect(rssRequest.variables).not.toHaveProperty('since_id');
        expect(cacheSet.mock.calls.some(([key]) => key.startsWith('twitter:developer-timeline:'))).toBe(true);
        const count = transport.requests.length;
        await api.getUserTweets('rsshub_test', {});
        expect(transport.requests).toHaveLength(count);
        cacheGet.mockRestore();
        cacheSet.mockRestore();
    });
});
