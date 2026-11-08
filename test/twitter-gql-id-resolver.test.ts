import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config, cache, ofetch } = vi.hoisted(() => ({
    config: { twitter: { authToken: ['test-session'] as string[] | undefined }, cache: { contentExpire: 3600 }, trueUA: 'test-browser' },
    cache: { get: vi.fn(), set: vi.fn() },
    ofetch: vi.fn(),
}));

vi.mock('../lib/config', () => ({ config }));
vi.mock('../lib/utils/cache', () => ({ default: cache }));
vi.mock('../lib/utils/ofetch', () => ({ default: ofetch }));
vi.mock('../lib/utils/logger', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const bundleUrl = 'https://abs.twimg.com/responsive-web/client-web/main.current123.js';
const page = `<script src="${bundleUrl}"></script>`;
const bundle = 'queryId:"current-user",operationName:"UserByScreenName";queryId:"current-tweets",operationName:"UserTweets";';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cache.get.mockResolvedValue(undefined);
    cache.set.mockResolvedValue(undefined);
    config.twitter.authToken = ['test-session'];
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Twitter query-ID discovery', () => {
    it('uses the configured session to obtain the web client without sending it to the CDN', async () => {
        ofetch.mockResolvedValueOnce(page).mockResolvedValueOnce(bundle);
        const { resolveQueryIds, fallbackIds } = await import('../lib/routes/twitter/api/web-api/gql-id-resolver');

        const ids = await resolveQueryIds();

        expect(ofetch).toHaveBeenNthCalledWith(1, 'https://x.com/?mx=2', expect.objectContaining({ headers: { cookie: 'auth_token=test-session', 'user-agent': 'test-browser' }, timeout: 10000, retry: 0 }));
        expect(ofetch).toHaveBeenNthCalledWith(2, bundleUrl, expect.objectContaining({ timeout: 10000, retry: 0 }));
        expect(ofetch.mock.calls[1][1]).not.toHaveProperty('headers');
        expect(ids.UserTweets).toBe('current-tweets');
        expect(ids.UserByScreenName).toBe('current-user');
        expect(ids.HomeTimeline).toBe(fallbackIds.HomeTimeline);
        expect(cache.set).toHaveBeenCalledWith('twitter:gql-query-ids', JSON.stringify({ UserByScreenName: 'current-user', UserTweets: 'current-tweets' }), 3600);
    });

    it('preserves the full bundle URL for a legacy client with a filename suffix', async () => {
        const url = 'https://abs.twimg.com/responsive-web/client-web-legacy/main.ABC_123.def.js';
        ofetch.mockResolvedValueOnce(`<script src="${url}"></script>`).mockResolvedValueOnce(bundle);
        const { resolveQueryIds } = await import('../lib/routes/twitter/api/web-api/gql-id-resolver');

        await resolveQueryIds();

        expect(ofetch.mock.calls[1][0]).toBe(url);
    });

    it('does not fetch bundle URLs outside the expected static asset host', async () => {
        ofetch.mockResolvedValue('<script src="https://example.org/responsive-web/client-web/main.abc.js"></script>');
        const { resolveQueryIds, fallbackIds } = await import('../lib/routes/twitter/api/web-api/gql-id-resolver');

        expect(await resolveQueryIds()).toEqual(fallbackIds);
        expect(ofetch).toHaveBeenCalledTimes(1);
    });

    it('allows anonymous discovery when no session is configured', async () => {
        config.twitter.authToken = undefined;
        ofetch.mockResolvedValueOnce(page).mockResolvedValueOnce(bundle);
        const { resolveQueryIds } = await import('../lib/routes/twitter/api/web-api/gql-id-resolver');

        await resolveQueryIds();

        expect(ofetch.mock.calls[0][1].headers).toEqual({ 'user-agent': 'test-browser' });
    });

    it('uses cached IDs without fetching a page', async () => {
        cache.get.mockResolvedValue(JSON.stringify({ UserTweets: 'cached-tweets' }));
        const { resolveQueryIds } = await import('../lib/routes/twitter/api/web-api/gql-id-resolver');

        expect((await resolveQueryIds()).UserTweets).toBe('cached-tweets');
        expect(ofetch).not.toHaveBeenCalled();
    });

    it('backs off after a static landing page and retries after a minute', async () => {
        vi.useFakeTimers();
        ofetch.mockResolvedValueOnce('<html>Static landing page</html>').mockResolvedValueOnce(page).mockResolvedValueOnce(bundle);
        const { resolveQueryIds, fallbackIds } = await import('../lib/routes/twitter/api/web-api/gql-id-resolver');

        expect(await resolveQueryIds()).toEqual(fallbackIds);
        expect(await resolveQueryIds()).toEqual(fallbackIds);
        expect(ofetch).toHaveBeenCalledTimes(1);
        expect(cache.set).not.toHaveBeenCalled();

        vi.advanceTimersByTime(60000);
        expect((await resolveQueryIds()).UserTweets).toBe('current-tweets');
        expect(ofetch).toHaveBeenCalledTimes(3);
    });

    it('retains fallback IDs and backs off when a request fails', async () => {
        ofetch.mockRejectedValue(new Error('Request timed out'));
        const { resolveQueryIds, fallbackIds } = await import('../lib/routes/twitter/api/web-api/gql-id-resolver');

        expect(await resolveQueryIds()).toEqual(fallbackIds);
        expect(await resolveQueryIds()).toEqual(fallbackIds);
        expect(ofetch).toHaveBeenCalledTimes(1);
        expect(cache.set).not.toHaveBeenCalled();
    });

    it('shares discovery across simultaneous feed requests', async () => {
        ofetch.mockResolvedValueOnce(page).mockResolvedValueOnce(bundle);
        const { resolveQueryIds } = await import('../lib/routes/twitter/api/web-api/gql-id-resolver');

        const results = await Promise.all([resolveQueryIds(), resolveQueryIds(), resolveQueryIds()]);

        expect(results.every((ids) => ids.UserTweets === 'current-tweets')).toBe(true);
        expect(ofetch).toHaveBeenCalledTimes(2);
    });
});
