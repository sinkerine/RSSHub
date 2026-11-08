import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/config', () => ({ config: {} }));
vi.mock('../lib/utils/cache', () => ({ default: {} }));
vi.mock('../lib/utils/logger', () => ({ default: {} }));
vi.mock('../lib/utils/ofetch', () => ({ default: vi.fn() }));
vi.mock('../lib/utils/proxy', () => ({ default: {} }));
vi.mock('../lib/routes/twitter/api/web-api/client-transaction', () => ({ getClientTransactionId: vi.fn() }));
vi.mock('../lib/routes/twitter/api/web-api/constants', () => ({}));
vi.mock('../lib/routes/twitter/api/web-api/login', () => ({ default: vi.fn() }));

const { gatherLegacyFromData } = await import('../lib/routes/twitter/api/web-api/utils');
const { normalizeUser } = await import('../lib/routes/twitter/api/web-api/user');

const modernUser = {
    rest_id: '123',
    core: { name: 'Artist', screen_name: 'artist' },
    avatar: { image_url: 'https://example.org/avatar.jpg' },
    profile_bio: { description: 'Artist bio', entities: { description: { urls: [] } } },
};

const tweet = (id: string, user: unknown) => ({
    rest_id: id,
    core: { user_results: { result: user } },
    legacy: { full_text: 'Drawing', user_id_str: '123' },
});

const entry = (data: unknown) => ({ entryId: 'tweet-456', content: { itemContent: { tweet_results: { result: data } } } });

describe('Twitter user normalization', () => {
    it('builds author and profile fields when the current API omits legacy', () => {
        expect(normalizeUser(modernUser)).toEqual({
            id_str: '123',
            name: 'Artist',
            screen_name: 'artist',
            profile_image_url: 'https://example.org/avatar.jpg',
            profile_image_url_https: 'https://example.org/avatar.jpg',
            description: 'Artist bio',
            entities: { description: { urls: [] } },
        });
    });

    it('preserves legacy fields and uses current core names', () => {
        expect(normalizeUser({ legacy: { name: 'Old name', screen_name: 'old', followers_count: 42 }, core: { name: 'New name', screen_name: 'new' } })).toEqual({
            name: 'New name',
            screen_name: 'new',
            followers_count: 42,
        });
    });

    it('hydrates tweet authors for both singular and plural user-result keys', () => {
        const plural = tweet('456', modernUser);
        const singular = { ...tweet('457', modernUser), core: { user_result: { result: modernUser } } };

        const tweets = gatherLegacyFromData([entry(plural), { ...entry(singular), entryId: 'tweet-457' }]);

        expect(tweets).toHaveLength(2);
        expect(tweets.map((item) => item.user.screen_name)).toEqual(['artist', 'artist']);
        expect(tweets.map((item) => item.id_str)).toEqual(['456', '457']);
    });

    it('hydrates retweet and quote authors using the same schema', () => {
        const data = tweet('456', modernUser);
        const original = tweet('789', modernUser);
        Object.assign(data.legacy, { retweeted_status_result: { result: original } });
        Object.assign(data, { quoted_status_result: { result: tweet('987', modernUser) } });

        const [item] = gatherLegacyFromData([entry(data)]);

        expect(item.user.name).toBe('Artist');
        expect(item.retweeted_status.user.name).toBe('Artist');
        expect(item.quoted_status.user.name).toBe('Artist');
    });
});
