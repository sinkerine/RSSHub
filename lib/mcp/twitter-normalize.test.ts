import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { normalizeProfile, normalizeTweet, tweetSchema } from './twitter-normalize';

const user = { id_str: '1', screen_name: 'author', name: 'Author', description: 'bio', profile_image_url_https: 'https://example.com/avatar', secret: 'private' };
const base = {
    id_str: '123',
    full_text: 'Hello &amp; &lt;world&gt; https://t.co/a https://t.co/media',
    user,
    created_at: '2025-01-30T12:00:00Z',
    favorite_count: 3,
    entities: {
        urls: [
            { url: 'https://t.co/a', expanded_url: 'https://example.com/a?q=keep' },
            { url: 'https://t.co/a', expanded_url: 'https://example.com/a?q=keep' },
        ],
        hashtags: [{ text: 'tag' }],
        user_mentions: [{ screen_name: 'friend' }],
    },
};
describe('Twitter native normalization', () => {
    it('expands links without URL redaction, decodes entities, removes media t.co and whitelists fields', () => {
        const tweet = normalizeTweet({ ...base, rawSecret: 'private', extended_entities: { media: [{ type: 'photo', url: 'https://t.co/media', media_url_https: 'https://example.com/photo', sizes: { large: { w: 20, h: 10 } } }] } });
        expect(tweetSchema.parse(tweet)).toMatchObject({
            id: '123',
            text: 'Hello & <world> https://example.com/a?q=keep ',
            links: ['https://example.com/a?q=keep'],
            hashtags: ['tag'],
            mentions: ['friend'],
            createdAt: '2025-01-30T12:00:00.000Z',
            metrics: { likes: 3 },
            media: [{ type: 'photo', url: 'https://example.com/photo', width: 20, height: 10 }],
        });
        expect(JSON.stringify(tweet)).not.toMatch(/rawSecret|private|entities|legacy|cookie/);
    });
    it('represents original repost fields and reposter separately, preserving quote/reply data', () => {
        const original = { ...base, in_reply_to_status_id_str: '2', in_reply_to_screen_name: 'parent', is_quote_status: true, quoted_status: { ...base, id_str: '3', quoted_status: { ...base, id_str: '4' } } };
        const result = normalizeTweet({ id_str: '999', user: { screen_name: 'reposter' }, retweeted_status: original }, ['999']);
        expect(result).toMatchObject({
            id: '123',
            author: { username: 'author' },
            isRetweet: true,
            isPinned: true,
            retweetedBy: { username: 'reposter' },
            isReply: true,
            replyTo: { tweetId: '2', username: 'parent' },
            isQuote: true,
            quoted: { id: '3' },
        });
        expect(result.quoted).not.toHaveProperty('quoted');
        expect(tweetSchema.safeParse(result).success).toBe(true);
    });
    it.each(['video', 'animated_gif'])('selects highest bitrate MP4 for %s and preserves poster/dimensions', (type) => {
        const result = normalizeTweet({
            ...base,
            extended_entities: {
                media: [
                    {
                        type,
                        media_url_https: 'https://example.com/poster',
                        original_info: { width: 100, height: 50 },
                        video_info: {
                            variants: [
                                { content_type: 'application/x-mpegURL', url: 'https://example.com/list.m3u8', bitrate: 9999 },
                                { content_type: 'video/mp4', bitrate: 20, url: 'https://example.com/low.mp4' },
                                { content_type: 'video/mp4', bitrate: 200, url: 'https://example.com/high.mp4' },
                            ],
                        },
                    },
                ],
            },
        });
        expect(result.media).toEqual([{ type, url: 'https://example.com/high.mp4', previewUrl: 'https://example.com/poster', width: 100, height: 50 }]);
    });
    it('omits unavailable author, invalid date/metrics and unavailable media rather than fabricating values', () => {
        const result = normalizeTweet({ id_str: '123', created_at: 'invalid', favorite_count: NaN, extended_entities: { media: [{ type: 'video' }] } });
        expect(result.url).toBe('https://x.com/i/status/123');
        expect(result).not.toHaveProperty('author');
        expect(result).not.toHaveProperty('createdAt');
        expect(result.metrics).toEqual({});
        expect(result.media).toEqual([]);
    });
    it('clips normal and quoted text without splitting UTF-16 surrogate pairs', () => {
        const result = normalizeTweet({ ...base, full_text: 'a'.repeat(3999) + '🔥', quoted_status: { ...base, full_text: 'a'.repeat(3999) + '🔥' } });
        expect(result.text).toHaveLength(3999);
        expect(result.textTruncated).toBe(true);
        expect(result.quoted?.textTruncated).toBe(true);
        expect(result.text.isWellFormed()).toBe(true);
    });
    it('normalizes note tweets through real GraphQL hydration before field selection', async () => {
        const data = JSON.parse(await readFile(new URL('../../scripts/e2e/fixtures/twitter-graphql/tweet-detail.json', import.meta.url), 'utf8'));
        const entries = data.data.threaded_conversation_with_injections_v2.instructions[0].entries;
        entries[0].content.itemContent.tweet_results.result.note_tweet = {
            note_tweet_results: { result: { text: 'Long note &amp; https://t.co/n', entity_set: { urls: [{ url: 'https://t.co/n', expanded_url: 'https://example.com/n' }], hashtags: [], user_mentions: [] } } },
        };
        const { gatherLegacyFromData } = await import('@/routes/twitter/api/web-api/utils');
        expect(normalizeTweet(gatherLegacyFromData(entries)[0]).text).toBe('Long note & https://example.com/n');
    });
    it('normalizes only the documented profile fields', () => {
        expect(normalizeProfile(user)).toEqual({ id: '1', username: 'author', name: 'Author', description: 'bio', profileImageUrl: 'https://example.com/avatar', url: 'https://x.com/author' });
    });
});
