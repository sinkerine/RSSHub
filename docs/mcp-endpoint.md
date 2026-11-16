# Twitter MCP endpoint

Set `MCP_ENABLE=true` to expose the Model Context Protocol endpoint at `/mcp` on the Node or Vercel server. It registers three direct Twitter tools: `twitter_search`, `twitter_user_tweets`, and `twitter_get_tweet`. The generic `search_routes` and `fetch_feed` tools have been removed; calling them returns the SDK unknown-tool error. The unrelated `/mcp/feed/:type?` RSS route is unchanged.

**There is no MCP authentication.** `ACCESS_KEY` still protects ordinary RSS feeds but does not gate `/mcp`; keys and Authorization headers do not authenticate MCP requests. Restrict access at the network or reverse proxy before enabling this endpoint. An unlisted `Origin` receives HTTP 403 before the SDK runs; requests without Origin are accepted. This Origin check is not authentication. Startup logs the unauthenticated warning.

The endpoint supports legacy stateless SSE (2025 protocol) and modern JSON (`2026-07-28`). GET and DELETE return 405; the request body limit is 65536 bytes. With MCP disabled, the endpoint is never imported and `/mcp` retains its not-found behavior. Cloudflare Workers do not include the MCP endpoint.

Every call reads one upstream page directly through the existing Twitter adapters. It does not use RSS rendering, route caches, in-progress claims, adapter result caches or the developer timeline snapshot. Identical calls make fresh upstream reads. User lookup, cookies, query-ID resolution, credential selection and token rotation remain shared with RSS. Ordinary Twitter RSS/Atom/JSON, `/api/*` and their caching behavior are unchanged.

Backend selection is unchanged: `TWITTER_THIRD_PARTY_API` or `TWITTER_AUTH_TOKEN` selects the web adapter; otherwise `TWITTER_CONSUMER_KEY` plus `TWITTER_CONSUMER_SECRET` selects the developer adapter. Search and user timelines support the third-party source. Tweet detail requires an auth token or developer credentials: the third-party API does not support TweetDetail. Availability and accepted search operators depend on X and the configured backend; no live-X availability is promised. Developer API search covers the last seven days, and each fresh page can incur API billing.

All three tools declare strict input and output schemas and `annotations: { readOnlyHint: true, openWorldHint: true }`.

## Inputs

```ts
// twitter_search
{
  query: string;   // 1–512 chars, passed verbatim to X
  limit?: number;  // int 1–20, default 20
  cursor?: string; // ^v1\.[A-Za-z0-9_-]+$, ≤ 4096 chars; a nextCursor from an earlier call with the same query
}

// twitter_user_tweets
{
  user: string;              // ^@?[A-Za-z0-9_]{1,15}$  or  ^\+[0-9]{1,20}$
  includeReplies?: boolean;  // default false
  includeRetweets?: boolean; // default true
  limit?: number;            // int 1–20, default 20
  cursor?: string;           // same format; bound to the same user + includeReplies
}

// twitter_get_tweet
{
  user: string;    // same pattern as above (the author)
  tweetId: string; // ^[0-9]{1,20}$
  limit?: number;  // int 1–20, default 20 — bounds `thread`
}
```

Unknown properties are rejected (`additionalProperties: false`, via a strict zod object).

## Tools and parameter descriptions

**`twitter_search`** — title "Search X posts"

> Search recent X (Twitter) posts, newest first, through RSSHub's configured Twitter backend. `query` is sent verbatim to X search; it is not URL-encoded or rewritten. Returns up to `limit` posts from one upstream page. To get older posts, pass the result's `nextCursor` as `cursor` with the same `query`. A missing `nextCursor` means there are no more results. Every call is a fresh read. Requires RSSHub Twitter credentials: TWITTER_AUTH_TOKEN, TWITTER_THIRD_PARTY_API, or TWITTER_CONSUMER_KEY + TWITTER_CONSUMER_SECRET (developer API, last 7 days only).

`query` description:

> X search expression (1–512 characters), using the same syntax as the x.com search box. Examples: `RSSHub`, `from:DIYgod RSSHub`, `"exact phrase"`, `rsshub OR miniflux`, `rsshub -bot`, `lang:en rsshub`. X interprets the operators; RSSHub does not validate them. Operator support depends on X and on the configured backend.

`cursor` description:

> Opaque `nextCursor` from an earlier `twitter_search` result with the same `query`. Omit it to get the newest posts. `limit` may differ between pages.

**`twitter_user_tweets`** — title "Get an X user's posts"

> Get recent posts from one X user's profile timeline (up to `limit` from one upstream page), plus the user's profile. The pinned post may appear first on the first page and is flagged `isPinned`. To get older posts, pass the result's `nextCursor` as `cursor` with the same `user` and `includeReplies`. A missing `nextCursor` means there are no more results. Every call is a fresh read. Requires TWITTER_AUTH_TOKEN, TWITTER_THIRD_PARTY_API, or TWITTER_CONSUMER_KEY + TWITTER_CONSUMER_SECRET.

- `user`: "X handle without @ (e.g. `DIYgod`; a leading @ is removed), or `+` followed by the numeric user ID (e.g. `+44196397`)."
- `includeReplies`: "Include the user's replies (X's 'Posts & replies' timeline). Default false returns only root posts."
- `includeRetweets`: "Include reposts. Default true. The filter is applied after fetching the single upstream page, so fewer than `limit` posts may be returned."
- `limit`: "Maximum posts to return, 1–20. Default 20."
- `cursor`: "Opaque `nextCursor` from an earlier `twitter_user_tweets` result with the same `user` and `includeReplies`. Omit it to get the newest posts. `limit` and `includeRetweets` may differ between pages."

**`twitter_get_tweet`** — title "Get an X post"

> Get one X post by author handle and post ID, plus the conversation posts X returns with it (ancestors and replies from a single page; none on the developer-API backend). Every call is a fresh read. Requires TWITTER_AUTH_TOKEN (web backend) or TWITTER_CONSUMER_KEY + TWITTER_CONSUMER_SECRET. TWITTER_THIRD_PARTY_API alone is not enough.

- `user`: "Author handle without @ or `+numericId`, taken from `x.com/<user>/status/<tweetId>`."
- `tweetId`: "Numeric post ID from `x.com/<user>/status/<tweetId>`."
- `limit`: "Maximum conversation posts in `thread`, 1–20. Default 20. The requested post is always returned."

## Outputs

```ts
type Author = { id?: string; username?: string; name?: string };

type Media = {
    type: 'photo' | 'video' | 'animated_gif';
    url: string; // photo: media_url_https; video/gif: highest-bitrate video/mp4 variant
    previewUrl?: string; // video/gif poster (media_url_https)
    width?: number;
    height?: number;
};

type QuotedTweet = {
    id: string;
    url: string;
    text: string;
    textTruncated: boolean;
    createdAt?: string;
    author?: Author;
    media: Media[];
    links: string[];
};

type Tweet = {
    id: string; // for reposts: the ORIGINAL post's id
    url: string; // https://x.com/<username>/status/<id> (https://x.com/i/status/<id> if no username)
    text: string; // t.co links expanded, media t.co links removed, &amp;/&lt;/&gt; decoded; ≤ 4000 UTF-16 units
    textTruncated: boolean;
    createdAt?: string; // ISO 8601; omitted if missing or invalid
    author?: Author; // original author (for reposts: not the reposter)
    lang?: string;
    isRetweet: boolean;
    isReply: boolean;
    isQuote: boolean;
    isPinned?: boolean; // twitter_user_tweets only
    retweetedBy?: Author; // present when isRetweet
    replyTo?: { tweetId: string; username?: string };
    quoted?: QuotedTweet; // one level; absent if X withheld it even when isQuote
    media: Media[];
    links: string[]; // expanded URLs, de-duplicated, upstream order
    hashtags: string[];
    mentions: string[]; // usernames
    metrics: { likes?: number; retweets?: number; replies?: number; quotes?: number };
};

type Common = {
    returnedCount: number; // length of tweets / thread
    sourceCount: number; // posts in the fetched upstream page before MCP resume/filters/limit
    truncated: { items: boolean; bytes: boolean; text: boolean };
    fetchedAt: string; // ISO completion time of this fresh read
    link: string; // human-readable x.com page
};
type Paged = { pagination: 'cursor'; nextCursor?: string }; // absent nextCursor = end of results

// twitter_search
type SearchOutput = Common & Paged & { query: string; tweets: Tweet[] };
// twitter_user_tweets
type UserTweetsOutput = Common &
    Paged & {
        user: { id: string; username: string; name?: string; description?: string; profileImageUrl?: string; url: string };
        tweets: Tweet[];
    };
// twitter_get_tweet
type GetTweetOutput = Common & { pagination: 'none'; tweet: Tweet; thread: Tweet[] };
```

Rules:

- Field sources by backend. `metrics.likes` comes from both backends. `retweets`, `replies`, `quotes` and `lang` are web-only, so they are optional. View counts are not exposed because the adapters do not carry them into legacy objects.
- Objects are built **field by field** from the adapter's legacy tweet objects. Raw adapter objects are never serialized; this is the structural protection for the success path (the error redaction rules below).
- Order is upstream order. `truncated.items` means `limit` or filters removed posts. `truncated.text` means any text was clipped. `truncated.bytes` means trailing posts (or `thread` entries) were dropped to fit `MCP_MAX_RESPONSE_BYTES`. The `twitter_get_tweet` focal `tweet` is never dropped.
- An empty `tweets` array is a successful result (e.g. no search matches). There is no "empty feed" error in this API. A page can be empty and still carry a `nextCursor`, for example when `includeRetweets=false` filters out a page made entirely of reposts. Only a missing `nextCursor` signals the end.

## Cursor paging

Search and user timelines page with `nextCursor`; there is no offset, larger per-call maximum or automatic multi-page fetch. Pass `nextCursor` as `cursor` on the next call with the same query, or the same user and `includeReplies`. Limit and includeRetweets may change. `twitter_get_tweet` has no cursor input and returns the conversation's first page only; the developer backend returns no thread.

A token is `v1.` plus base64url JSON: `{ t, b, k, c?, a? }`. `t` is the paged tool, `b` the web/developer backend, `k` the first 16 hex characters of SHA-256 over canonical upstream arguments, `c` the upstream cursor, and `a` a numeric upstream entry ID to resume after within that page. Handle binding strips @ and lowercases the handle; the search string remains byte-identical. Reposts resume by their original timeline entry ID, even though normalized output describes the reposted post.

The server resumes after `a` when it is present on the freshly fetched page, then filters reposts and applies limit and response-byte bounds. If posts remain, the next cursor resumes after the last returned entry within that same upstream page. Otherwise it advances to X's Bottom cursor (including TimelineReplaceEntry) or developer next_token. An empty upstream page, absent Bottom cursor or repeated upstream cursor ends paging. An empty result after repost filtering can still have a next cursor; only an absent nextCursor signals the end. Pages can shift between requests, and clients should de-duplicate by post ID. When `a` is absent from a shifted page, processing resumes from the page start.

**Tokens are unsigned and have no expiry or secret.** Validation has three classes:

1. Pattern/length violations are SDK input errors (text only).
2. Undecodable JSON, unknown fields, invalid version/shape/types or a wrong tool/backend/argument hash return `invalid_cursor` before taking a limiter slot or calling X.
3. A well-formed token with an edited `c` or `a`, while keeping its binding, is indistinguishable from a genuine token. Edited `c` is forwarded to X; the response can be a page, an empty result or an upstream error. Edited `a` absent from the page resumes from its start. This does not provide tamper detection or a cryptographic security boundary.

## Errors and execution limits

Tool failures return `isError: true`, `structuredContent: { error: { code, message, retryable, retryAfterSeconds?, phase? } }`, and an identical JSON text block. SDK input-schema rejection happens before the callback and returns `Input validation error` text without structuredContent. Removed tools return the SDK unknown-tool error.

| Code                  | Retryable | Meaning                                                                     |
| --------------------- | --------- | --------------------------------------------------------------------------- |
| invalid_parameter     | no        | Invalid or unavailable Twitter user/parameter                               |
| not_found             | no        | Requested focal post absent from detail response                            |
| invalid_cursor        | no        | Malformed cursor or mismatched tool/backend/arguments; retry without cursor |
| source_config_missing | no        | No configured backend, or third-party-only TweetDetail                      |
| upstream_rate_limited | yes       | Upstream 429; retryAfterSeconds is included when Retry-After is available   |
| upstream_error        | yes       | Other source or HTTP failure                                                |
| capacity_exceeded     | yes       | Per-process limiter and queue are full                                      |
| timeout               | yes       | Deadline exceeded, with phase `queued` or `running`                         |
| internal_error        | no        | Internal processing or response-bound failure                               |

Errors redact credential-named config strings of six or more characters and URL userinfo, query and fragment, then clip messages to 300 UTF-16 units. Successes are built field by field from the public output schema. Tweet text and public links are not URL-redacted, so legitimate query strings remain intact. No raw user, legacy, cookie, token or transport objects are exposed.

Cursor validation runs before admission. A single per-process FIFO limiter and deadline bound each call. Cancelled or timed-out queued calls never reach the source. A running call keeps its limiter slot until the adapter settles, even after timeout or HTTP cancellation, because the shared adapters cannot abort transport. Late completion writes no result cache. Response byte bounds drop trailing posts/thread entries and set truncated.bytes; the focal post is always retained. Paging resumes after the last retained entry when response bounds reduce a page.

The existing `twitter:lock-token1:*` token lock is a **best-effort lease**, with a non-atomic cache get/set, no owner, and an expiry that can be extended after rate limiting. It does not guarantee strict account serialization across RSS and MCP, processes or replicas. The MCP limiter bounds MCP work within one process only.

## Configuration

| Variable               | Default         | Behavior                                                                                                                                |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| MCP_ENABLE             | false           | Enables `/mcp` without authentication                                                                                                   |
| MCP_TOOLS              | all three tools | Comma-separated, trimmed tool names. An explicitly empty value registers none. Unknown names warn once each at startup and are ignored. |
| MCP_ROUTES             | removed         | Ignored; startup warning points to MCP_TOOLS                                                                                            |
| MCP_MAX_ITEMS          | removed         | Ignored; startup warning. Per-call limit is fixed at 1–20, default 20.                                                                  |
| MCP_MAX_CONCURRENCY    | 1               | Positive per-process active call bound                                                                                                  |
| MCP_MAX_QUEUE          | 4               | Nonnegative FIFO queue bound                                                                                                            |
| MCP_TIMEOUT            | 50 seconds      | Positive queued and running deadline                                                                                                    |
| MCP_MAX_RESPONSE_BYTES | 262144          | Minimum 65536; smaller or invalid values use the default                                                                                |
| MCP_ALLOWED_ORIGINS    | empty           | Comma-separated exact Origins allowed in addition to requests without Origin                                                            |

Enabling MCP without a Twitter backend logs a startup warning. Tools stay registered and return source_config_missing. Enabling an obsolete route/item config logs a migration warning so a former path restriction cannot silently be mistaken for the new tool catalog.

## Client example

```js
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'x-reader', version: '1.0.0' });
// For modern JSON: add { versionNegotiation: { mode: { pin: '2026-07-28' } } }.
await client.connect(new StreamableHTTPClientTransport(new URL('https://rsshub.example/mcp')));
try {
    console.log(await client.listTools());
    console.log(await client.callTool({ name: 'twitter_user_tweets', arguments: { user: 'DIYgod', includeRetweets: false, limit: 5 } }));
    console.log(await client.callTool({ name: 'twitter_get_tweet', arguments: { user: 'DIYgod', tweetId: '1650844643997646852' } }));
    let cursor;
    for (let page = 0; page < 3; page++) {
        const result = await client.callTool({ name: 'twitter_search', arguments: { query: 'from:DIYgod RSSHub', limit: 10, ...(cursor && { cursor }) } });
        if (result.isError) throw new Error(result.content[0].text);
        const output = result.structuredContent;
        console.log(output.tweets);
        cursor = output.nextCursor;
        if (!cursor) break;
    }
} finally {
    await client.close();
}
```

## Verification scope

The synthetic dev/production E2E harness uses a loopback third-party GraphQL source and blocks external sockets. It exercises real MCP clients, adapter acquisition, normalization, freshness, paging, errors, lifecycle limits and unchanged protected RSS. Its feed comparisons use a fixed server wall clock and canonical request Host so generated RSS build timestamps and self-link origins can be compared byte for byte across isolated server ports. The capability mode separately establishes acquisition and discovery before product implementation. The full journey is run by an independent verifier; a prepared harness alone does not establish a passed journey.

Real-entry integration tests cover successful TweetDetail through the actual web/developer adapters with only transport substituted, including focal/thread selection and missing focal behavior. Synthetic fixtures verify known Bottom cursor and TimelineReplaceEntry shapes, not live X behavior or whether a particular third-party proxy forwards cursors. No live X/Twitter, developer API service, Redis multi-process, HTTPS/proxy deployment, replica behavior or particular agent product is verified by this journey.

Worker bundle checks distinguish this endpoint from pre-existing browser vendor code. The feature adds no `lib/mcp` or new MCP server/client/core code to the Worker. The pinned browser transport already bundles vendor `@modelcontextprotocol/sdk`/ajv through Patchright's utilsBundle; that existing vendor inclusion remains unchanged, so a broad package-name grep is not empty. The approved plan's execution clarification records this baseline limitation and preserves browser behavior.
