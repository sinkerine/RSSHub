/* oxlint-disable regexp/prefer-d, regexp/prefer-w, regexp/use-ignore-case -- Preserve the approved public schema patterns. */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import NotFoundError from '@/errors/types/not-found';

import type { Cursor } from './cursor';
import { cursorBinding, decodeCursor, nextCursor, resumePage } from './cursor';
import type { ExecutorDeps, ToolResult } from './executor';
import { runTool } from './executor';
import { normalizeProfile, normalizeTweet, profileSchema, tweetSchema } from './twitter-normalize';
import type { TwitterSource } from './twitter-source';

export const toolNames = ['twitter_search', 'twitter_user_tweets', 'twitter_get_tweet'] as const;
export const descriptions = {
    twitter_search:
        "Search recent X (Twitter) posts, newest first, through RSSHub's configured Twitter backend. `query` is sent verbatim to X search; it is not URL-encoded or rewritten. Returns up to `limit` posts from one upstream page. To get older posts, pass the result's `nextCursor` as `cursor` with the same `query`. A missing `nextCursor` means there are no more results. Every call is a fresh read. Requires RSSHub Twitter credentials: TWITTER_AUTH_TOKEN, TWITTER_THIRD_PARTY_API, or TWITTER_CONSUMER_KEY + TWITTER_CONSUMER_SECRET (developer API, last 7 days only).",
    twitter_user_tweets:
        "Get recent posts from one X user's profile timeline (up to `limit` from one upstream page), plus the user's profile. The pinned post may appear first on the first page and is flagged `isPinned`. To get older posts, pass the result's `nextCursor` as `cursor` with the same `user` and `includeReplies`. A missing `nextCursor` means there are no more results. Every call is a fresh read. Requires TWITTER_AUTH_TOKEN, TWITTER_THIRD_PARTY_API, or TWITTER_CONSUMER_KEY + TWITTER_CONSUMER_SECRET.",
    twitter_get_tweet:
        'Get one X post by author handle and post ID, plus the conversation posts X returns with it (ancestors and replies from a single page; none on the developer-API backend). Every call is a fresh read. Requires TWITTER_AUTH_TOKEN (web backend) or TWITTER_CONSUMER_KEY + TWITTER_CONSUMER_SECRET. TWITTER_THIRD_PARTY_API alone is not enough.',
};
const user = z.string().regex(/^(?:@?[A-Za-z0-9_]{1,15}|\+[0-9]{1,20})$/);
const limit = z.number().int().min(1).max(20).default(20).describe('Maximum posts to return, 1–20. Default 20.');
const cursor = z
    .string()
    .regex(/^v1\.[A-Za-z0-9_-]+$/)
    .max(4096)
    .optional();
export const searchInputSchema = z.strictObject({
    query: z
        .string()
        .min(1)
        .max(512)
        .describe(
            'X search expression (1–512 characters), using the same syntax as the x.com search box. Examples: `RSSHub`, `from:DIYgod RSSHub`, `"exact phrase"`, `rsshub OR miniflux`, `rsshub -bot`, `lang:en rsshub`. X interprets the operators; RSSHub does not validate them. Operator support depends on X and on the configured backend.'
        ),
    limit,
    cursor: cursor.describe('Opaque `nextCursor` from an earlier `twitter_search` result with the same `query`. Omit it to get the newest posts. `limit` may differ between pages.'),
});
export const userTweetsInputSchema = z.strictObject({
    user: user.describe('X handle without @ (e.g. `DIYgod`; a leading @ is removed), or `+` followed by the numeric user ID (e.g. `+44196397`).'),
    includeReplies: z.boolean().default(false).describe("Include the user's replies (X's 'Posts & replies' timeline). Default false returns only root posts."),
    includeRetweets: z.boolean().default(true).describe('Include reposts. Default true. The filter is applied after fetching the single upstream page, so fewer than `limit` posts may be returned.'),
    limit,
    cursor: cursor.describe('Opaque `nextCursor` from an earlier `twitter_user_tweets` result with the same `user` and `includeReplies`. Omit it to get the newest posts. `limit` and `includeRetweets` may differ between pages.'),
});
export const getTweetInputSchema = z.strictObject({
    user: user.describe('Author handle without @ or `+numericId`, taken from `x.com/<user>/status/<tweetId>`.'),
    tweetId: z
        .string()
        .regex(/^[0-9]{1,20}$/)
        .describe('Numeric post ID from `x.com/<user>/status/<tweetId>`.'),
    limit: limit.describe('Maximum conversation posts in `thread`, 1–20. Default 20. The requested post is always returned.'),
});
const common = {
    returnedCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().nonnegative(),
    truncated: z.strictObject({ items: z.boolean(), bytes: z.boolean(), text: z.boolean() }),
    fetchedAt: z.string(),
    link: z.string(),
};
const paged = { pagination: z.literal('cursor'), nextCursor: z.string().optional() };
export const searchOutputSchema = z.strictObject({ ...common, ...paged, query: z.string(), tweets: z.array(tweetSchema) });
export const userTweetsOutputSchema = z.strictObject({ ...common, ...paged, user: profileSchema, tweets: z.array(tweetSchema) });
export const getTweetOutputSchema = z.strictObject({ ...common, pagination: z.literal('none'), tweet: tweetSchema, thread: z.array(tweetSchema) });
export interface ToolDeps extends ExecutorDeps {
    twitter: TwitterSource;
}
const textTruncated = (tweets: Array<ReturnType<typeof normalizeTweet>>) => tweets.some((tweet) => tweet.textTruncated || tweet.quoted?.textTruncated);
export function registerTwitterTools(server: McpServer, deps: ToolDeps, request?: Request) {
    const annotations = { readOnlyHint: true, openWorldHint: true };
    const signals = (signal: AbortSignal) => [signal, ...(request ? [request.signal] : [])];
    if (deps.mcpConfig.tools.includes('twitter_search')) {
        server.registerTool('twitter_search', { title: 'Search X posts', description: descriptions.twitter_search, inputSchema: searchInputSchema, outputSchema: searchOutputSchema, annotations }, (input, ctx) => {
            const binding = cursorBinding('twitter_search', deps.twitter.backend, { query: input.query });
            let decoded: Cursor | undefined;
            return runTool(
                'twitter_search',
                deps,
                signals(ctx.mcpReq.signal),
                async () => {
                    const page = await deps.twitter.search(input.query, decoded?.c ? { cursor: decoded.c } : undefined);
                    return pagedResult(page, input.limit, true, decoded, binding, { query: input.query, link: `https://x.com/search?q=${encodeURIComponent(input.query)}` });
                },
                () => {
                    decoded = decodeCursor(input.cursor, binding);
                }
            );
        });
    }
    if (deps.mcpConfig.tools.includes('twitter_user_tweets')) {
        server.registerTool(
            'twitter_user_tweets',
            { title: "Get an X user's posts", description: descriptions.twitter_user_tweets, inputSchema: userTweetsInputSchema, outputSchema: userTweetsOutputSchema, annotations },
            (input, ctx) => {
                const username = input.user.replace(/^@/, '');
                const binding = cursorBinding('twitter_user_tweets', deps.twitter.backend, { user: username, includeReplies: input.includeReplies });
                let decoded: Cursor | undefined;
                return runTool(
                    'twitter_user_tweets',
                    deps,
                    signals(ctx.mcpReq.signal),
                    async () => {
                        const page = await deps.twitter.userTweets(username, input.includeReplies, decoded?.c ? { cursor: decoded.c } : undefined);
                        const profile = normalizeProfile(page.user);
                        return pagedResult(page, input.limit, input.includeRetweets, decoded, binding, { user: profile, link: profile.url }, page.user.pinned_tweet_ids_str);
                    },
                    () => {
                        decoded = decodeCursor(input.cursor, binding);
                    }
                );
            }
        );
    }
    if (deps.mcpConfig.tools.includes('twitter_get_tweet')) {
        server.registerTool('twitter_get_tweet', { title: 'Get an X post', description: descriptions.twitter_get_tweet, inputSchema: getTweetInputSchema, outputSchema: getTweetOutputSchema, annotations }, (input, ctx) =>
            runTool('twitter_get_tweet', deps, signals(ctx.mcpReq.signal), async () => {
                const page = await deps.twitter.getTweet(input.user.replace(/^@/, ''), input.tweetId);
                const focal = page.find((tweet) => tweet.id_str === input.tweetId || tweet.retweeted_status?.id_str === input.tweetId);
                if (!focal) {
                    throw new NotFoundError('The focal post is absent from the source response');
                }
                const tweet = normalizeTweet(focal);
                const others = page.filter((entry) => entry !== focal);
                const output = {
                    returnedCount: 0,
                    sourceCount: page.length,
                    truncated: { items: others.length > input.limit, bytes: false, text: false },
                    fetchedAt: new Date().toISOString(),
                    link: tweet.url,
                    pagination: 'none' as const,
                    tweet,
                    thread: others.slice(0, input.limit).map((entry) => normalizeTweet(entry)),
                };
                const refresh = () => {
                    output.returnedCount = output.thread.length;
                    output.truncated.text = textTruncated([tweet, ...output.thread]);
                };
                refresh();
                return {
                    output,
                    trim() {
                        if (!output.thread.length) {
                            return false;
                        }
                        output.thread.pop();
                        output.truncated.bytes = true;
                        refresh();
                        return true;
                    },
                };
            })
        );
    }
}
function pagedResult(
    page: { tweets: any[]; nextCursor?: string },
    limit: number,
    includeRetweets: boolean,
    cursor: Cursor | undefined,
    binding: ReturnType<typeof cursorBinding>,
    fields: Record<string, unknown>,
    pinned?: string[]
): ToolResult {
    const resumed = resumePage(page.tweets, cursor);
    const filtered = includeRetweets ? resumed : resumed.filter((tweet) => !tweet.retweeted_status);
    const selected = filtered.slice(0, limit);
    const output = {
        ...fields,
        returnedCount: 0,
        sourceCount: page.tweets.length,
        truncated: { items: filtered.length !== resumed.length || filtered.length > limit, bytes: false, text: false },
        fetchedAt: new Date().toISOString(),
        pagination: 'cursor' as const,
        tweets: selected.map((tweet) => normalizeTweet(tweet, pinned)),
        nextCursor: undefined as string | undefined,
    };
    const refresh = () => {
        output.returnedCount = output.tweets.length;
        output.truncated.text = textTruncated(output.tweets);
        output.nextCursor = nextCursor(binding, cursor, page.tweets.length, filtered.length, selected, page.nextCursor);
    };
    refresh();
    return {
        output,
        trim() {
            if (output.tweets.length <= 1) {
                return false;
            }
            output.tweets.pop();
            selected.pop();
            output.truncated.bytes = true;
            refresh();
            return true;
        },
    };
}
