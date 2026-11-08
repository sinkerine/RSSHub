import { config } from '@/config';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';

const CACHE_KEY = 'twitter:gql-query-ids';

// Hardcoded fallback IDs (last known working values)
export const fallbackIds: Record<string, string> = {
    UserTweets: 'eoJ5zbv51Z_KVl81v9PmLQ',
    UserByScreenName: 'Gb-d6r0vxPOADdG62OEBpQ',
    HomeTimeline: '3b9_7tltt0hJRef-xm_3sw',
    HomeLatestTimeline: 'm1G65W9TS1-g-AllrKKYDQ',
    UserTweetsAndReplies: 'wc5DRl4VaW5lSqJ8YbftZQ',
    UserMedia: '2DC9TKrcUzwGC_QskSVl5w',
    UserByRestId: 'xvmVfRLmnr1alc5f2dib0Q',
    SearchTimeline: 'BGd0T_j7oVwlW5U79tO_0A',
    ListLatestTweetsTimeline: 'jW040BLUjh8X6Tw2ODQufA',
    TweetDetail: '559hs_YZNV4IgA3Z6zIIuw',
    AudioSpaceById: 'ipEqgz4P_bZCGY3fBnfsxQ',
};

const operationNames = Object.keys(fallbackIds);

async function fetchTwitterPage(): Promise<string> {
    // Anonymous visitors can receive a static landing page without the web client.
    const token = config.twitter.authToken?.find(Boolean);
    const response = await ofetch('https://x.com/?mx=2', {
        headers: {
            'user-agent': config.trueUA,
            ...(token && { cookie: `auth_token=${token}` }),
        },
        timeout: 10000,
        retry: 0,
        parseResponse: (txt) => txt,
    });
    return response as unknown as string;
}

function extractQueryIds(scriptContent: string): Record<string, string> {
    const ids: Record<string, string> = {};
    const matches = scriptContent.matchAll(/queryId:"([^"]+)".+?operationName:"([^"]+)"/g);
    for (const match of matches) {
        const [, queryId, operationName] = match;
        if (operationNames.includes(operationName)) {
            ids[operationName] = queryId;
        }
    }
    return ids;
}

async function fetchAndExtractWebIds(): Promise<Record<string, string>> {
    const html = await fetchTwitterPage();

    // Preserve the advertised URL, including any client variant or filename suffix.
    const mainUrl = html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/main\.[\w.-]+\.js\b/)?.[0];
    if (!mainUrl) {
        logger.warn('twitter gql-id-resolver: main.js URL not found in Twitter page; the session may be invalid or X may have changed its page');
        return {};
    }

    logger.debug(`twitter gql-id-resolver: fetching ${mainUrl}`);

    // Do not forward X session cookies to the static asset host.
    const content = await ofetch(mainUrl, {
        timeout: 10000,
        retry: 0,
        parseResponse: (txt) => txt,
    });
    return extractQueryIds(content as unknown as string);
}

interface InternalApiDocument {
    graphql?: Record<string, { queryId?: string } | undefined>;
}

async function fetchAndExtractIds(): Promise<Record<string, string>> {
    try {
        const ids = await fetchAndExtractWebIds();
        if (Object.keys(ids).length > 0) {
            return ids;
        }
    } catch {
        logger.warn('twitter gql-id-resolver: web client discovery failed, trying TwitterInternalAPIDocument');
    }

    const api = await ofetch<InternalApiDocument>('https://cdn.jsdelivr.net/gh/fa0311/TwitterInternalAPIDocument@master/docs/json/API.json', {
        timeout: 10000,
        retry: 0,
    });
    const ids: Record<string, string> = {};
    for (const name of operationNames) {
        const queryId = api?.graphql?.[name]?.queryId;
        if (typeof queryId === 'string' && queryId.length > 0) {
            ids[name] = queryId;
        }
    }
    return ids;
}

let resolvePromise: Promise<Record<string, string>> | null = null;
let retryAfter = 0;
const FAILURE_RETRY_DELAY = 60000;

export async function resolveQueryIds(): Promise<Record<string, string>> {
    // Check cache first
    const cached = await cache.get(CACHE_KEY);
    if (cached) {
        try {
            const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                logger.debug('twitter gql-id-resolver: using cached query IDs');
                return { ...fallbackIds, ...parsed };
            }
        } catch {
            // ignore parse error
        }
    }

    // Avoid fetching the same unusable landing page for every feed request.
    if (Date.now() < retryAfter) {
        return { ...fallbackIds };
    }

    // Deduplicate concurrent requests
    if (!resolvePromise) {
        resolvePromise = (async () => {
            try {
                logger.info('twitter gql-id-resolver: fetching fresh query IDs from Twitter JS bundles');
                const ids = await fetchAndExtractIds();

                if (Object.keys(ids).length > 0) {
                    retryAfter = 0;
                    await cache.set(CACHE_KEY, JSON.stringify(ids), config.cache.contentExpire);
                    const found = operationNames.filter((name) => ids[name]);
                    const missing = operationNames.filter((name) => !Object.hasOwn(ids, name));
                    logger.info(`twitter gql-id-resolver: resolved ${found.length}/${operationNames.length} query IDs. Missing: ${missing.join(', ') || 'none'}`);
                } else {
                    retryAfter = Date.now() + FAILURE_RETRY_DELAY;
                    logger.warn('twitter gql-id-resolver: failed to extract any query IDs, using fallback; discovery will retry in 60s');
                }

                return ids;
            } catch (error) {
                retryAfter = Date.now() + FAILURE_RETRY_DELAY;
                logger.warn(`twitter gql-id-resolver: error fetching query IDs: ${error}. Using fallback; discovery will retry in 60s.`);
                return {};
            } finally {
                resolvePromise = null;
            }
        })();
    }

    const ids = await resolvePromise;
    return { ...fallbackIds, ...ids };
}

export function buildGqlMap(queryIds: Record<string, string>): Record<string, string> {
    const map: Record<string, string> = {};
    for (const name of operationNames) {
        const id = queryIds[name] || fallbackIds[name];
        map[name] = `/graphql/${id}/${name}`;
    }
    return map;
}
