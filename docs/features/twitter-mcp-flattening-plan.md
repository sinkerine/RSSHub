# Twitter MCP flattening — design plan

Status: **REVISION r2.2 — APPROVED by the user as written on 2026-11-15 23:18 PST** (see §8). r2 was approved 2026-11-15 23:05 PST, and r2.1 was a process-only verification correction. r2.2 corrects the AC11/J10 cursor-tamper contradiction (D15) and adds execution-readiness detail.
Worktree: `quiet-pelican` at `f212dfdeb` (clean). Base feature: `docs/features/mcp-endpoint-plan.md` (completed, merged; not edited by this plan).

## 1. Goal, scope and decision record

### Goal

Replace the generic MCP surface (`search_routes` + `fetch_feed` over RSS route paths) with **three typed, self-describing Twitter tools**. They read Twitter directly through RSSHub's existing Twitter adapters and return a **defined JSON schema**, not RSS. MCP reuses RSSHub's infrastructure (Twitter backends, credentials, token rotation/locks, user-ID lookup cache, config, HTTP server, logging). It does **not** use RSS feed state: no route cache, no in-progress claims, no RSS rendering, and no adapter result caches. Search and user timelines support **real upstream cursor paging** (§2.6). There is no offset and the per-call limit stays at 20.

### Decision record

| #   | Decision                                                                                                                                                                                                                                                                                                              | Source                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D1  | Backward compatibility of the MCP tool surface is **not required**. `search_routes` and `fetch_feed` are **removed** with no aliases, shims or deprecation period.                                                                                                                                                    | User: "don't need keep existing api"                                                                                       |
| D2  | MCP is a pure search/read API **without RSS state**. Tools call `lib/routes/twitter/api` directly. No `app.fetch` dispatch, no RSS route cache/claims, no `ProcessFeed` rendering.                                                                                                                                    | User question + choice **A**                                                                                               |
| D3  | **Always fresh**: MCP calls bypass the Twitter adapters' result caches (5-min per-user timeline/tweet caches, developer-API search cache and timeline snapshot), through new uncached _page_ functions on the shared adapters (§3). RSS calls keep the current caching.                                               | User choice **A**                                                                                                          |
| D4  | Shared **non-RSS** infrastructure is kept: auth-token rotation and `twitter:lock-token1:*` locks, the cookie cache, the 24 h handle→ID lookup cache, GraphQL query-ID resolution and backend selection. No duplicate Twitter transport/auth/locking and no browser.                                                   | Brief; confirmed in the choice-A context                                                                                   |
| D5  | Output is a **tweet-native JSON schema** (§2.3); there is no `content: text/html/none` option.                                                                                                                                                                                                                        | User: "I don't want the result to be rss … defined json schema"                                                            |
| D6  | Catalog = **`twitter_search`, `twitter_user_tweets`, `twitter_get_tweet`**. No home timelines (either variant), likes, lists or media timeline.                                                                                                                                                                       | User answers: no getHomeTimeline; selected "search + user_tweets + get_tweet"                                              |
| D7  | Expose retweet/media filters **only where the routes actually support them**. With D6 this leaves `includeRetweets` on `twitter_user_tweets`. `onlyMedia` existed only on list/home/likes, so it is not offered.                                                                                                      | User choice: "Expose where routes support them"                                                                            |
| D8  | `MCP_ROUTES` is replaced by **`MCP_TOOLS`**, a comma list that defaults to all tools. Unlisted tools are not registered.                                                                                                                                                                                              | User choice                                                                                                                |
| D9  | `twitter_get_tweet` takes **`user` + `tweetId`**, with no URL parsing.                                                                                                                                                                                                                                                | User choice                                                                                                                |
| D10 | **No MCP authentication** (unchanged). `MCP_ENABLE=true` opts in, `ACCESS_KEY` does not gate `/mcp`, the startup warning stays and the Origin check stays.                                                                                                                                                            | Prior user decision; not reopened                                                                                          |
| D11 | Ordinary RSSHub RSS/Atom/JSON feeds, `/api/*` and all `/twitter/*` RSS routes stay unchanged: byte-identical output and the same caching.                                                                                                                                                                             | Brief                                                                                                                      |
| D12 | Out of scope: deployment, remote credential/agent setup, and live Twitter/X requests.                                                                                                                                                                                                                                 | Brief                                                                                                                      |
| D13 | **Cursor paging** on `twitter_search` and `twitter_user_tweets`: an opaque `cursor` input and a `nextCursor` output, built from X's real upstream cursors (web: Bottom timeline cursor; developer API: `meta.next_token`). AGENTS.md rule 27 ("first page only") still governs RSS routes; RSS routes gain no paging. | User: "do we also support paging…", then chose option 2                                                                    |
| D15 | Cursors stay **unsigned**. Only malformed or mismatched tokens are rejected (`invalid_cursor`, X unhit); a well-formed token with edited `c`/`a` is forwarded to X and not detected (§2.6). There is no HMAC and no cursor secret.                                                                                    | User chose "Keep unsigned; correct the criteria" after the parent's handoff audit found AC11/J10 promised tamper detection |
| D14 | **No `offset`** and **no larger maximum**: `limit` stays 1–20 per call (R1). Older posts are reached by following `nextCursor`.                                                                                                                                                                                       | User chose option 2 ("no offset"); R1 kept                                                                                 |

Implementation details decided by the designer (reversible; open for review at approval):

- R1 `limit` is 1–20 with default 20, the size of one upstream page. More posts are reached through `nextCursor`, not a larger limit. **`MCP_MAX_ITEMS` is removed** because every adapter fetches a single page of about 20 posts, so higher caps were never meaningful.
- R2 The `MCP_MAX_RESPONSE_BYTES` minimum rises from 4096 to **65536**, so one maximal tweet plus its quote always fits. The default stays 262144.
- R3 If `MCP_ROUTES` or `MCP_MAX_ITEMS` is set, startup logs one warning that it is ignored and that `MCP_TOOLS` controls exposure. This is a migration warning, not a compatibility shim. It matters because a narrowed `MCP_ROUTES` must not silently widen exposure.
- R4 Startup warns once if MCP is enabled and no Twitter backend is configured. Tools stay registered and calls return `source_config_missing`.
- R5 Credential requirements appear in each tool description, which is the text agents read. There is no non-standard `_meta`.

## 2. Tool catalog

All three tools declare an input schema and an output schema and have `annotations: { readOnlyHint: true, openWorldHint: true }`. Each call makes one fresh upstream read of a single page. `twitter_search` and `twitter_user_tweets` return `pagination: 'cursor'` and page with real upstream cursors (§2.6). `twitter_get_tweet` returns `pagination: 'none'`: its thread is the first page that X returns.

### 2.1 Inputs

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

### 2.2 Descriptions (exact agent-facing text)

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

### 2.3 Output schemas

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
- Objects are built **field by field** from the adapter's legacy tweet objects. Raw adapter objects are never serialized; this is the structural protection for the success path (§4.5).
- Order is upstream order. `truncated.items` means `limit` or filters removed posts. `truncated.text` means any text was clipped. `truncated.bytes` means trailing posts (or `thread` entries) were dropped to fit `MCP_MAX_RESPONSE_BYTES`. The `twitter_get_tweet` focal `tweet` is never dropped.
- An empty `tweets` array is a successful result (e.g. no search matches). There is no "empty feed" error in this API. A page can be empty and still carry a `nextCursor`, for example when `includeRetweets=false` filters out a page made entirely of reposts. Only a missing `nextCursor` signals the end.

### 2.4 Representative `tools/list` (modern era; exact rendering pinned by a snapshot test)

```json
{
    "tools": [
        {
            "name": "twitter_search",
            "title": "Search X posts",
            "description": "Search recent X (Twitter) posts, newest first, through RSSHub's configured Twitter backend. `query` is sent verbatim to X search; it is not URL-encoded or rewritten. …",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "maxLength": 512, "description": "X search expression (1–512 characters) … Examples: `RSSHub`, `from:DIYgod RSSHub`, …" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20, "description": "Maximum posts to return, 1–20. Default 20." },
                    "cursor": { "type": "string", "minLength": 1, "maxLength": 4096, "pattern": "^v1\\.[A-Za-z0-9_-]+$", "description": "Opaque `nextCursor` from an earlier `twitter_search` result with the same `query`. …" }
                },
                "required": ["query"],
                "additionalProperties": false
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "tweets": { "type": "array", "items": { "$ref": "#/$defs/Tweet" } },
                    "returnedCount": { "type": "integer", "minimum": 0 },
                    "sourceCount": { "type": "integer", "minimum": 0 },
                    "truncated": { "type": "object", "properties": { "items": { "type": "boolean" }, "bytes": { "type": "boolean" }, "text": { "type": "boolean" } }, "required": ["items", "bytes", "text"] },
                    "fetchedAt": { "type": "string" },
                    "pagination": { "const": "cursor" },
                    "nextCursor": { "type": "string" },
                    "link": { "type": "string" }
                },
                "required": ["query", "tweets", "returnedCount", "sourceCount", "truncated", "fetchedAt", "pagination", "link"],
                "$defs": { "Tweet": { "type": "object", "properties": { "id": { "type": "string" }, "url": { "type": "string" }, "text": { "type": "string" }, "…": "per §2.3" } } }
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": true }
        },
        {
            "name": "twitter_user_tweets",
            "title": "Get an X user's posts",
            "description": "Get recent posts from one X user's profile timeline …",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "user": {
                        "type": "string",
                        "pattern": "^@?[A-Za-z0-9_]{1,15}$|^\\+[0-9]{1,20}$",
                        "description": "X handle without @ (e.g. `DIYgod`; a leading @ is removed), or `+` followed by the numeric user ID (e.g. `+44196397`)."
                    },
                    "includeReplies": { "type": "boolean", "default": false, "description": "Include the user's replies (X's 'Posts & replies' timeline). Default false returns only root posts." },
                    "includeRetweets": {
                        "type": "boolean",
                        "default": true,
                        "description": "Include reposts. Default true. The filter is applied after fetching the single upstream page, so fewer than `limit` posts may be returned."
                    },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 },
                    "cursor": { "type": "string", "minLength": 1, "maxLength": 4096, "pattern": "^v1\\.[A-Za-z0-9_-]+$" }
                },
                "required": ["user"],
                "additionalProperties": false
            },
            "outputSchema": { "…": "Common + Paged + user + tweets per §2.3" },
            "annotations": { "readOnlyHint": true, "openWorldHint": true }
        },
        {
            "name": "twitter_get_tweet",
            "title": "Get an X post",
            "description": "Get one X post by author handle and post ID, plus the conversation posts X returns with it …",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "user": { "type": "string", "pattern": "^@?[A-Za-z0-9_]{1,15}$|^\\+[0-9]{1,20}$" },
                    "tweetId": { "type": "string", "pattern": "^[0-9]{1,20}$" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 }
                },
                "required": ["user", "tweetId"],
                "additionalProperties": false
            },
            "outputSchema": { "…": "Common + tweet + thread per §2.3" },
            "annotations": { "readOnlyHint": true, "openWorldHint": true }
        }
    ]
}
```

If the SDK's zod→JSON Schema conversion inlines definitions instead of `$defs`, that is acceptable. The snapshot test pins whatever the SDK actually emits.

### 2.5 Real-client examples

```js
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'; // @2.4.0

const client = new Client({ name: 'x-reader', version: '1.0.0' }); // add { versionNegotiation: { mode: { pin: '2026-07-28' } } } for the modern era
await client.connect(new StreamableHTTPClientTransport(new URL('https://rsshub.example/mcp')));
try {
    const { tools } = await client.listTools(); // exactly the MCP_TOOLS-enabled twitter_* tools
    const search = await client.callTool({ name: 'twitter_search', arguments: { query: 'from:DIYgod RSSHub', limit: 10 } });
    const posts = await client.callTool({ name: 'twitter_user_tweets', arguments: { user: 'DIYgod', includeReplies: false, includeRetweets: false, limit: 5 } });
    const post = await client.callTool({ name: 'twitter_get_tweet', arguments: { user: 'DIYgod', tweetId: '1650844643997646852' } });
    console.log(search.structuredContent.tweets[0]?.url, posts.structuredContent.user.username, post.structuredContent.tweet.text);

    // Paging: follow nextCursor with the same query; stop when it is absent.
    let cursor;
    for (let page = 0; page < 3; page++) {
        const { structuredContent } = await client.callTool({ name: 'twitter_search', arguments: { query: 'rsshub', ...(cursor && { cursor }) } });
        console.log(structuredContent.tweets.map((t) => t.id));
        cursor = structuredContent.nextCursor;
        if (!cursor) break;
    }
} finally {
    await client.close();
}
```

Example success (`twitter_search`, abbreviated):

```json
{
    "query": "from:DIYgod RSSHub",
    "tweets": [
        {
            "id": "1650844643997646852",
            "url": "https://x.com/DIYgod/status/1650844643997646852",
            "text": "RSSHub … https://docs.rsshub.app",
            "textTruncated": false,
            "createdAt": "2023-04-25T12:00:00.000Z",
            "author": { "id": "1052566394", "username": "DIYgod", "name": "DIYgod" },
            "isRetweet": false,
            "isReply": false,
            "isQuote": false,
            "media": [],
            "links": ["https://docs.rsshub.app"],
            "hashtags": [],
            "mentions": [],
            "metrics": { "likes": 42, "retweets": 3, "replies": 5 }
        }
    ],
    "returnedCount": 1,
    "sourceCount": 18,
    "truncated": { "items": true, "bytes": false, "text": false },
    "fetchedAt": "2026-11-15T20:10:00.000Z",
    "pagination": "cursor",
    "nextCursor": "v1.eyJ0Ijoi…",
    "link": "https://x.com/search?q=from%3ADIYgod%20RSSHub"
}
```

Example error (`isError: true`; the text content is the identical JSON):

```json
{ "error": { "code": "source_config_missing", "message": "The Twitter backend is not configured for this tool. No valid Twitter token found", "retryable": false } }
```

### 2.6 Cursor paging (`twitter_search`, `twitter_user_tweets`)

**Token.** `nextCursor` is `v1.` followed by base64url(JSON) of:

```ts
{
  t: 'twitter_search' | 'twitter_user_tweets';
  b: 'web' | 'developer';   // backend that produced it
  k: string;                // first 16 hex chars of sha256 over the canonical upstream arguments
  c?: string;               // upstream cursor of the page to fetch (absent = newest page)
  a?: string;               // resume after this upstream entry id within that page
}
```

Canonical upstream arguments: `{ query }` for search, and `{ user: handle without @ lowercased, or +id, includeReplies }` for user tweets. `limit` and `includeRetweets` are not bound, because they don't change the upstream request. The token is **not signed** (decision D15). It is not a security boundary: `c` only ever becomes an X cursor string inside a request for the _same_ query or user, made with the server's own credentials, so a forged token can at worst cause an upstream error or return a page of that same timeline. The token's format and length are validated by the schema.

**Validation.** There are three classes, and only the first two are detectable:

1. **Schema-invalid**: breaks the `^v1\.[A-Za-z0-9_-]+$` pattern or the 1–4096 length. The SDK returns `Input validation error` text before the callback.
2. **Malformed or mismatched (runtime `invalid_cursor`, X never called)**:
    - _Malformed_: the base64url doesn't decode, the content isn't a JSON object, there are unknown keys, `t`/`b` aren't one of the allowed values, `k` isn't 16 lowercase hex, `c`/`a` are present but not non-empty strings, or `a` is not `^[0-9]{1,20}$`. (`a` without `c` is valid: it resumes within the newest page.)
    - _Mismatched_: `t` ≠ the called tool, `b` ≠ the active backend, or `k` ≠ the hash of this call's canonical arguments.
    - Message: "This cursor is malformed or does not belong to this query or backend; call again without cursor."
3. **Well-formed but edited**: `t`/`b`/`k` kept and `c` and/or `a` changed to other well-typed values. This is **indistinguishable from a genuine token** and is not detected. The edited `c` is forwarded to X as `variables.cursor` / `next_token` / `pagination_token`. The result is whatever X returns: a page of the same query/user, an empty page (end), or a failure mapped to `upstream_error`. An edited `a` that isn't on the page resumes from the page start (§2.6 step 1). The plan does not claim tamper detection.

**Producing `nextCursor`.** For a call that fetched upstream page P (requested with cursor `c`, or none):

1. Take P's posts in upstream order. If `a` is set and found, skip through it. If `a` is not found because the newest page shifted, skip nothing; duplicates are then possible and agents de-duplicate by `id`.
2. Apply `includeRetweets`, then `limit`, then the byte bound.
3. If posts of P were left out by `limit` or the byte bound, `nextCursor = { c, a: <upstream id of the last returned post> }`. The next call refetches P fresh and resumes after that post, so no post is lost when `limit < 20`.
4. Otherwise, if P had at least one post and an upstream next cursor that differs from `c`, `nextCursor = { c: <that cursor> }`.
5. Otherwise, `nextCursor` is absent (end). This rule stops X's endless empty-page cursors and guards against cursor loops.

The upstream id is the timeline entry's own `id_str`. For reposts that is the repost id, not the original id shown as `Tweet.id`.

**Semantics.** Each page is a separate tool call: it takes its own limiter slot and deadline, makes a fresh read and writes nothing to a cache. RSSHub never fetches several pages in one call. Pages reflect X's timeline at fetch time, so posts may shift between calls. The token carries no expiry. If X rejects a stale upstream cursor, the call returns `upstream_error`. There is no `offset`, no page number and no total count.

## 3. Argument → adapter mapping (verified against current source)

Backend selection is unchanged (`lib/routes/twitter/api/index.ts`). `TWITTER_THIRD_PARTY_API` or `TWITTER_AUTH_TOKEN` selects the **web** adapter. Otherwise `TWITTER_CONSUMER_KEY`+`SECRET` selects the **developer** adapter. Otherwise `init()` throws `ConfigNotFoundError`. On the web adapter, GraphQL calls go to the third-party API only for `thirdPartySupportedAPI` (`UserByScreenName`, `UserByRestId`, `UserTweets`, `UserTweetsAndReplies`, `ListLatestTweetsTimeline`, `SearchTimeline`, `UserMedia`). Every other call goes through `twitterGot`, which throws `ConfigNotFoundError('No valid Twitter token found')` without `TWITTER_AUTH_TOKEN`. Each tool first calls `api.init()`, which resolves the GraphQL query IDs through cache, as the RSS routes do.

### `twitter_search`

| Argument       | Web adapter (`getSearch`)                                                                                                                                  | Developer adapter (`getSearch`)                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `query`        | GraphQL `SearchTimeline` variables `{ rawQuery: query, count: 20, querySource: 'typed_query', product: 'Latest' }`, JSON-stringified by `paginationTweets` | `GET /2/tweets/search/recent?query=…&max_results=20` via twitter-api-v2 (the client encodes it) |
| `limit`        | MCP slice of the returned page                                                                                                                             | same                                                                                            |
| `cursor` (`c`) | appended last as `variables.cursor`; next = the Bottom cursor (§3 adapter change)                                                                          | `next_token=<c>`; next = `meta.next_token`                                                      |
| freshness      | `getSearchPage` is uncached; `getSearch` had no adapter result cache anyway                                                                                | `getSearchPage` bypasses the `twitter:search:<q>:<params>` `cache.tryGet` used by `getSearch`   |

- **Encoding:** the query is a JS string inside GraphQL `variables` (web) or a client-encoded query parameter (developer). The MCP contract does no path segment and no URL encoding, so the old `/twitter/keyword/<encoded>` problems (`%`, `/`, `#`, `?`) disappear. `link` = `https://x.com/search?q=${encodeURIComponent(query)}`, the same as the RSS route.
- **Validated structured parameters:** only `query` length (1–512; 512 is the X API v2 recent-search query limit for standard access) and `limit`. **Free-form:** everything inside `query`. The examples in the description (`from:`, quotes, `OR`, `-term`, `lang:`) are X syntax. RSSHub neither parses nor validates them, and no claim is made that a given operator works on a given backend.
- **Not offered:** a `Top`/`Media`/`People` product. The adapter hard-codes `product: 'Latest'`, and changing it would alter shared adapter and RSS semantics. There is also no `since`/`until` structured field; agents put those operators in `query`.

### `twitter_user_tweets`

| Argument                         | Web adapter                                                                                                                                                                   | Developer adapter                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `user`                           | leading `@` stripped; `+<digits>` → `UserByRestId`, else `UserByScreenName` (cached 24 h `twitter:web:userdata:v2:<user>`, kept)                                              | `client.v2.user`/`userByUsername` (cached `twitter-userdata-<user>`, kept)                                                 |
| `includeReplies=false` (default) | `getUserTweets` → `UserTweets` `{ count: 20, … }`; the adapter drops replies and self-thread continuations                                                                    | `getUserTweets` → `/2/users/:id/tweets` with `exclude=replies`                                                             |
| `includeReplies=true`            | `getUserTweetsAndReplies` → `UserTweetsAndReplies`                                                                                                                            | `/2/users/:id/tweets` (no exclude)                                                                                         |
| `includeRetweets=false`          | `utils.excludeRetweet` (existing route helper) applied **before** `limit`                                                                                                     | same                                                                                                                       |
| profile                          | `api.getUser(user)` → `normalizeUser` fields (`id_str`, `screen_name`, `name`, `description`, `profile_image_url_https`); `isPinned` from `pinned_tweet_ids_str` when present | `mapUserToLegacy`; `isPinned` omitted when unavailable                                                                     |
| `cursor` (`c`)                   | `variables.cursor` on `UserTweets`/`UserTweetsAndReplies`; next = Bottom cursor                                                                                               | `pagination_token=<c>` on `/2/users/:id/tweets`; next = `meta.next_token`                                                  |
| freshness                        | `getUserTweets[AndReplies]Page` skip the `twitter:<restId>:getUserTweets[AndReplies]:<params>` result cache                                                                   | the page functions skip that result cache **and** the `twitter:developer-timeline:*` since_id snapshot (no read, no write) |

The route's legacy `routeParams` (`count`, the `exclude_rts` shorthands, `forceWebApi`, and the readable-layout flags) are RSS rendering or compatibility controls and are not exposed. `count` is not forwarded: the adapter default of 20 equals the page size and the `limit` bound. `forceWebApi` is parsed but never used by any handler in current source.

Developer-API billing note: page functions skip the since_id snapshot, so each developer-backend call (each page) requests a full page.

### `twitter_get_tweet`

| Argument  | Web adapter                                                                                                                                                | Developer adapter                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `user`    | user lookup (cached, kept), then `TweetDetail` keyed by its `rest_id`                                                                                      | user lookup, then `GET /2/tweets/:tweetId` |
| `tweetId` | `focalTweetId` in `TWEET_DETAIL_PARAMS`, the exact parameter object used by the RSS route, moved to `lib/routes/twitter/utils.ts` so both use one constant | `focalTweetId`                             |
| `limit`   | bounds `thread`                                                                                                                                            | — (thread is always empty)                 |
| freshness | `getTweetDetail` skips the `twitter:<restId>:getUserTweet:<params>` result cache                                                                           | same                                       |
| paging    | none: first `TweetDetail` page only                                                                                                                        | —                                          |

The focal post is the entry whose `id_str === tweetId` (or whose original post id matches, for reposts). `thread` holds all other returned posts in upstream order. If the focal post is absent, the call fails with `not_found`. `TweetDetail` is not third-party supported, so with only `TWITTER_THIRD_PARTY_API` the call fails with `source_config_missing`, before any request to X.

### Adapter change (the only edit to Twitter code)

```ts
// lib/routes/twitter/api/index.ts — added to TwitterApi and to the unconfigured stub (which returns null like the rest)
export interface TweetPage { tweets: any[]; nextCursor?: string } // legacy tweet objects + upstream next cursor
getSearchPage(query: string, options?: { cursor?: string }): Promise<TweetPage>;
getUserTweetsPage(user: string, options?: { cursor?: string }): Promise<TweetPage>;
getUserTweetsAndRepliesPage(user: string, options?: { cursor?: string }): Promise<TweetPage>;
getTweetDetail(user: string, tweetId: string): Promise<any[]>;
```

- **Page functions are uncached by construction** and are only called by MCP. They still resolve the user through the cached lookup (`getUserData`), which is kept. The existing RSS functions become cached wrappers over the _same_ internals: `getUserTweets = cacheTryGet(…, async (id, params) => (await userTweetsPage(id, params)).tweets)`. There is no duplicate request code.
- **Web:** `paginationTweets` is split into `fetchTimelinePage(endpoint, userId, variables, path) → { entries, bottomCursor? }`, and `paginationTweets` returns `(await fetchTimelinePage(…)).entries`, unchanged for RSS. `bottomCursor` is the `content.value` of the timeline entry whose `content.cursorType === 'Bottom'` (entry id `cursor-bottom-*`). It is read from `TimelineAddEntries` first, then from any `TimelineReplaceEntry` instruction, where X places it on later search pages. When the page is called with a cursor, the page functions append `cursor` **last** in `variables`. RSS never passes a cursor, so its variables, request URLs and cache keys stay byte-identical.
- **Developer:** the single request in `getUserTimeline` is factored into `requestUserTimeline(id, requestParams) → { tweets, nextToken? }`, which reads `response.meta?.next_token`. The RSS `getUserTimeline` keeps its since_id snapshot around it. `getUserTweets[AndReplies]Page` call it directly with `pagination_token`, and no snapshot is read or written. `getSearchPage` makes the same `tweets/search/recent` request as `getSearch`, plus `next_token`, without `cache.tryGet`.
- **Verification status:** no current source handles X cursors at all (`cursor`, `next_token` and `pagination_token` appear nowhere). The Bottom-cursor entry and `TimelineReplaceEntry` shapes follow X's known GraphQL timeline format; they are verified by synthetic fixtures only, never live. If no Bottom cursor is found, `nextCursor` is omitted: paging ends rather than loops. Whether a given `TWITTER_THIRD_PARTY_API` proxy forwards `variables.cursor` is outside RSSHub's control.
- `TWEET_DETAIL_PARAMS` keeps identical key order, so the route cache key is unchanged.

## 4. Internal design and simplification

### 4.1 Module layout (after)

```
lib/mcp/
  index.ts            createMcpEndpoint({ mcpConfig?, twitter? }): Origin check → SDK handler (unchanged transport options)
  server.ts           buildMcpServer(deps, request): registers enabled tool definitions from the catalog table
  executor.ts         runTool(): deadline + signal merge + limiter + error classification/redaction + byte bound + log line
  twitter-tools.ts    the 3 tool definitions: zod input/output schemas, descriptions, argument mapping, envelope building
  twitter-source.ts   TwitterSource interface + createTwitterSource() over the '@/routes/twitter/api' page/detail functions and route utils
  cursor.ts           v1 cursor encode/decode/binding and the nextCursor rules (§2.6)
  twitter-normalize.ts legacy tweet/user objects → Tweet/QuotedTweet/profile (§2.3)
  errors.ts           pruned code set (§4.4), classifyError, createRedactor (kept), toolError
  limiter.ts          unchanged
  origin.ts           unchanged
  text.ts             unchanged (clipText)
  test-harness.ts     rewritten: in-process server + real SDK clients + injectable TwitterSource / fixture upstream
```

`createMcpEndpoint` no longer receives `fetch`. `lib/app-bootstrap.tsx` mounts `app.all('/mcp', createMcpEndpoint())` at the same position (before `compress()` and all global feed middleware). The unauthenticated warning text is unchanged.

### 4.2 Shared executor (one path for all tools)

`runTool(name, ctx, request, work)`:

Strict order. Steps 0–1 run in the tool callback **outside** the limiter; everything that touches X runs inside `work`.

0. **Pre-admission validation (synchronous, no slot, no X call):** normalize `user` (strip `@`), compute the canonical-argument hash, and decode and validate `cursor` (§2.6 classes 2). Failure returns `invalid_cursor` immediately and logs `mcp <tool> invalid_cursor <ms>ms`.
1. `deadline = AbortSignal.timeout(MCP_TIMEOUT s)`; `signal = AbortSignal.any([ctx.mcpReq.signal, request.signal, deadline])`. The deadline starts only after step 0.
2. `limiter.run(work, signal)`: FIFO, `MCP_MAX_CONCURRENCY`/`MCP_MAX_QUEUE` per process. A full queue fails immediately with `capacity_exceeded`.
3. `work` receives the already-decoded cursor. It calls the `TwitterSource` (`api.init()`, user lookup, one page request), applies the resume, filter and limit rules (§2.6), normalizes and builds the envelope, including `nextCursor`. It then enforces `MCP_MAX_RESPONSE_BYTES` by dropping trailing posts (never the focal post). If the bound still fails, the result is `internal_error`; the 65536 minimum makes that practically unreachable.
4. Errors: `CapacityError` → `capacity_exceeded`. `LimiterAbortError` with the deadline aborted → `timeout` with `phase`. `LimiterAbortError` from client or HTTP cancellation is rethrown, so the SDK drops the response as today. Everything else goes through `classifyError`, then the redactor, then `toolError`.
5. One log line per call, `mcp <tool> <status> <ms>ms`, without arguments.

Cancellation semantics are unchanged. A queued call that is cancelled or times out is removed and never touches Twitter. A running call returns to the caller but keeps its slot until the adapter promise settles, because the adapters accept no abort signal. Page and detail functions write nothing to a result cache, so a late completion has no side effects beyond the shared token lock and lookup caches. MCP reuses the existing `twitterGot` token rotation and `twitter:lock-token1:<token>` lock exactly as RSS does, unchanged and shared. That lock is a best-effort lease: a non-atomic `cache.get`/`cache.set` pair with no owner and a 20 s expiry (longer after rate limits). It does **not** provide strict per-account serialization across concurrent RSS and MCP requests, processes or replicas, and this plan makes no stronger promise. The MCP limiter bounds MCP calls per process only.

### 4.3 Authorization model replacing the route allowlist

The fixed tool catalog filtered by `MCP_TOOLS` **is** the authorization boundary. MCP has no path input and no `app.fetch`, so it cannot reach any other RSSHub route, `/api/*`, `/healthz`, `/metrics`, `/` or `/mcp` itself. The root-route-admission regression fix (`match()` excluding `/`, `/mcp`, `/api/*`, …) protected a path dispatcher that no longer exists; that protection is now structural. A test asserts that `lib/mcp` has no dispatch dependency: `createMcpEndpoint` takes no fetch, and calling `fetch_feed` or `search_routes` returns the SDK unknown-tool error.

### 4.4 Error schema boundary

`{ error: { code, message, retryable, retryAfterSeconds?, phase? } }`, always with `isError: true`, `structuredContent` and an identical JSON text block. **SDK input-schema rejections happen before the callback.** They return `isError: true` with `Input validation error` text and no `structuredContent`, so schema-rejected input never receives a coded error. This is documented and tested.

| Code                    | Retryable | Source                                                                                                      |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `invalid_parameter`     | no        | `InvalidParameterError` from adapters (nonexistent/unavailable account, "User not found")                   |
| `not_found`             | no        | `twitter_get_tweet` focal post absent; `NotFoundError`                                                      |
| `invalid_cursor`        | no        | cursor malformed, or its tool/backend/argument hash doesn't match (§2.6 class 2); returned before admission |
| `source_config_missing` | no        | `ConfigNotFoundError` (no backend; `TweetDetail` without auth token)                                        |
| `upstream_rate_limited` | yes       | status 429 or Twitter `error: 429` text; `retryAfterSeconds` from `Retry-After`                             |
| `upstream_error`        | yes       | any other adapter or HTTP failure                                                                           |
| `capacity_exceeded`     | yes       | limiter full                                                                                                |
| `timeout`               | yes       | deadline; `phase: 'queued' \| 'running'`                                                                    |
| `internal_error`        | no        | MCP processing failure (e.g. byte bound unreachable)                                                        |

Removed codes (unreachable without the RSS pipeline): `invalid_arguments`, `route_not_allowed`, `route_not_found`, `access_denied`, `captcha_required`, `request_in_progress`, `empty_result`, `unsupported_result`.

### 4.5 Redaction

The structural-redaction regression fix (recursive `redactValue` over `search_routes` metadata) protected config-derived metadata that no longer exists. Replacements:

- **Errors:** always pass through `createRedactor(config)`, which removes credential-named config values of 6+ characters and URL userinfo/query/fragment, and are clipped to 300 characters. Examples: a `TWITTER_THIRD_PARTY_API` URL with `?key=`, or an auth token in an exception message.
- **Successes:** built only from whitelisted normalized fields (§2.3). Tweet text and links are upstream content and are **not** URL-redacted, since that would corrupt legitimate links with query strings. Tests assert that no raw legacy field (e.g. `user.legacy`, `entities`, cookies, tokens) appears in output.

### 4.6 Protocol compatibility (unchanged)

`@modelcontextprotocol/server@2.4.0` `createMcpHandler(..., { legacy: 'stateless', responseMode: 'json', maxRequestBodySize: 65536 })`. Legacy 2025 initialization uses SSE responses (stateless); the modern `2026-07-28` per-request protocol uses JSON. GET and DELETE return 405. The Origin check runs before the SDK, and an unlisted `Origin` gets 403 `{"error":"forbidden_origin"}`. Node dev and prod servers and Vercel mount MCP as today; the Cloudflare Worker does not.

### 4.7 Configuration (changed semantics)

| Variable                                                | After                                                                                                                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_ENABLE`                                            | unchanged (default `false`)                                                                                                                                                                    |
| `MCP_TOOLS`                                             | **new**. Comma list, trimmed, empty entries dropped. Unset means all three tools. Set but empty means **none** are registered. Unknown names produce one startup warning each and are ignored. |
| `MCP_ROUTES`                                            | **removed**; warning if set (R3)                                                                                                                                                               |
| `MCP_MAX_ITEMS`                                         | **removed**; `limit` is fixed at 1–20 (R1); warning if set (R3)                                                                                                                                |
| `MCP_MAX_CONCURRENCY` / `MCP_MAX_QUEUE` / `MCP_TIMEOUT` | unchanged (1 / 4 / 50 s)                                                                                                                                                                       |
| `MCP_MAX_RESPONSE_BYTES`                                | default 262144; **minimum 65536** (R2)                                                                                                                                                         |
| `MCP_ALLOWED_ORIGINS`                                   | unchanged                                                                                                                                                                                      |

`config.mcp` becomes `{ enable, tools, maxConcurrency, maxQueue, timeout, maxResponseBytes, allowedOrigins }`. `DEFAULT_MCP_ROUTES` is deleted.

### 4.8 Obsolete code to delete (no compatibility retention)

- `lib/mcp/allowlist.ts`, `catalog.ts`, `dispatch.ts`, `result.ts` and their `.test.ts` files.
- `lib/utils/internal-request.ts`, plus its hooks and tests in `lib/errors/index.tsx` and `.test.ts`, `lib/middleware/access-control.ts` and `.test.ts` (the "internal MCP access boundary" block), and `lib/middleware/template.tsx` and `.test.ts`. These revert to their pre-MCP behavior. They existed only for `fetch_feed`, and ordinary request behavior is unaffected because no HTTP request could set the Symbol.
- `ensureNamespacesLoaded` in `lib/registry.ts` and `ensureLoaded` in `lib/registry-dev.ts`, plus their test in `lib/registry-dev.test.ts`. They were only used by allowlist discovery; a grep confirms no other user.
- The `lib/mcp` imports of `@/magpie/catalog` and `@/magpie/feed` (`lib/magpie` itself stays).
- `scripts/e2e/fixtures/e2e-mcp.mjs`, the generic fixture feed routes. The ordinary-feed comparison reuses `scripts/e2e/fixtures/e2e-smoke.mjs` as the user-route fixture.
- `search_routes`/`fetch_feed` sections of `docs/mcp-endpoint.md`, rewritten for the new catalog.

Kept: the `@modelcontextprotocol/server` and `@modelcontextprotocol/client` dependencies, `limiter.ts`, `origin.ts`, `text.ts`, the error redactor, the Origin/405/body-limit transport, the app-bootstrap mount, `lib/routes/mcp/*` (the unrelated mcp.so RSS route), and the `scripts/workflow/check-orphan-files.ts` exemption.

### 4.9 Protected, unchanged behavior

- All `/twitter/*` RSS routes produce byte-identical RSS/Atom/JSON, with the same ETags and route and adapter cache keys and TTLs.
- `ACCESS_KEY` gating of feeds is unchanged. `/mcp` stays ungated. `/mcp/feed/:type?` (mcp.so route) is unaffected.
- With `MCP_ENABLE=false`, `@/mcp` is never imported and `/mcp` keeps its not-found behavior.
- The Worker bundle must not gain `lib/mcp` or `@modelcontextprotocol/*` (verified; §5).

## 5. Acceptance criteria, task, files and verification

### 5.1 Observable acceptance criteria

- **AC1** `tools/list` (both protocol eras) returns exactly the `MCP_TOOLS`-enabled subset of `twitter_search`, `twitter_user_tweets`, `twitter_get_tweet`. Schemas, descriptions, defaults, bounds and annotations match §2, pinned by snapshot. `search_routes` and `fetch_feed` are absent, and calling them returns the SDK unknown-tool error.
- **AC2** Each argument reaches the adapter exactly as in §3. Examples: the search query arrives byte-identical in `rawQuery`, including quotes, `#`, `%`, `/`, `?` and non-ASCII. `includeReplies` switches `UserTweets`↔`UserTweetsAndReplies`. `includeRetweets=false` filters before `limit`. `@` is stripped and `+id` uses `UserByRestId`. `get_tweet` sends `TWEET_DETAIL_PARAMS` + `focalTweetId`. Cursors reach X as `variables.cursor` (web) or `next_token`/`pagination_token` (developer); without a cursor, the variables are identical to the RSS request.
- **AC3** Outputs validate against the declared output schemas, contain only §2.3 fields, and normalize correctly for web-shaped and developer-shaped fixtures: reposts, quotes, replies, note posts, photo/video/gif, t.co expansion, entity decoding, missing user, invalid date, and clipping at a surrogate pair.
- **AC4** **No RSS state:** two identical MCP calls produce two upstream timeline/search requests and only one user-lookup request. An RSS request for the same user does not satisfy a later MCP call, and an MCP call does not populate RSS route or adapter caches. An MCP call made while an RSS request for the same feed is held completes independently, never with `request_in_progress`.
- **AC5** Errors follow §4.4, with redaction (§4.5) and identical structured and text JSON. Schema rejections give the SDK text-only error.
- **AC6** Limits: `capacity_exceeded`; `timeout` in both phases; queued cancellation never calls the source; running cancellation keeps the slot until settlement; the byte bound drops trailing posts and sets `truncated.bytes`, and the focal post is kept.
- **AC7** Transport: Origin 403, GET/DELETE 405, the 65536-byte body limit, legacy SSE and modern JSON both work, and there is no authentication with `ACCESS_KEY` set.
- **AC8** Config: §4.7 parsing, defaults and warnings (unknown tool, obsolete variables, no backend).
- **AC9** Unchanged feeds: with MCP disabled vs enabled, `/test/1`, the `e2e-smoke` user route and `/twitter/user/<fixture>` plus `/twitter/keyword/<fixture>` (through the fixture third-party API) have byte-identical RSS and JSON bodies and equal ETags. `ACCESS_KEY` behavior is unchanged. The default (non-fresh) adapter path still caches.
- **AC10** Every check in the §5.4 inventory passes on final inputs: format, eslint, typecheck (whole project), full unit+coverage suite with Redis, the junit baseline comparison, Node build, `build:lib`, Vercel build, Worker build, the workerd suite and the new MCP E2E (dev + production bundle). The junit comparison is exact: every test case that passed at baseline passes at final, except cases in the test files this plan deletes (§4.8: `lib/mcp/{allowlist,catalog,dispatch,result}.test.ts`) and the removed hook cases in `lib/errors/index.test.ts`, `lib/middleware/{access-control,template}.test.ts` and `lib/registry-dev.test.ts` (§4.8). The comparison lists those removals by name. The Worker bundle contains no `lib/mcp` and no `@modelcontextprotocol` code.
- **AC11** Paging (§2.6): following `nextCursor` reaches older pages; `limit < 20` loses no posts (resume after id); the end is signalled by an absent `nextCursor` (no Bottom cursor, empty upstream page, or a repeated cursor); a Bottom cursor in `TimelineReplaceEntry` is found; **malformed or mismatched** cursors (§2.6 class 2: undecodable, wrong version/shape/types, or wrong tool/backend/argument hash) return `invalid_cursor` without calling X; a **well-formed token with an edited `c`** is forwarded as that upstream cursor (the fixture records it) and the result is X's response; an edited `a` absent from the page resumes from the page start; `twitter_get_tweet` has no cursor input.
- **AC12** `twitter_get_tweet` success through the real entry: an MCP client `tools/call` over HTTP reaches the real tool, executor, `createTwitterSource`, the web adapter's `getTweetDetail` → `twitterGot` → `gatherLegacyFromData` and the normalizer. Only the network transport is a fixture. The result has the focal `tweet` matched by `tweetId` and the other returned posts in `thread` (bounded by `limit`), and `TweetDetail` was requested with `TWEET_DETAIL_PARAMS` + `focalTweetId`. The developer-backend path does the same through the real developer adapter with the twitter-api-v2 transport as the fixture: focal tweet, empty `thread`. A focal post missing from the response → `not_found`. This formalizes evidence for behavior already approved in §2–§3.

State and lifecycle transitions introduced, each with its proof:

| Transition                                                                                                    | Proof                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Repeated identical call (no cache reuse)                                                                      | AC4: `twitter-source.test.ts`, E2E J4                        |
| MCP call while an RSS request for the same feed is held, and vice versa                                       | AC4: E2E J4                                                  |
| Cursor walk: first page → resume within page (`a`) → next page (`c`) → end                                    | AC11: `cursor.test.ts`, E2E J10                              |
| Cursor reused with another query/tool/backend; backend changed between pages (restart with other credentials) | AC11: `cursor.test.ts` (mismatched `b`), E2E J10             |
| Resume id missing after the newest page shifted                                                               | AC11: `cursor.test.ts` (duplicates allowed, nothing skipped) |
| Queued call cancelled or timed out; running call cancelled or timed out (slot kept until settlement)          | AC6: `executor.test.ts`, E2E J6                              |
| Queue full, then capacity freed                                                                               | AC6: `executor.test.ts`, E2E J6                              |
| Restart with a different `MCP_TOOLS`                                                                          | AC1/AC8: `twitter-tools.test.ts`, E2E J7                     |
| Upstream 429, then retry after `retryAfterSeconds`                                                            | AC5: `executor.test.ts`, E2E J6                              |

AC → evidence (each behavior AC drives the named entry paths through the real implementing code; fake `TwitterSource` tests are supplementary edge-case coverage, never the sole proof of a behavior AC):

| AC   | Entry paths / variants                                                                                             | Evidence                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| AC1  | legacy SSE and modern JSON; `MCP_TOOLS` unset/subset/empty/unknown                                                 | `twitter-tools.test.ts` (real SDK client over HTTP); E2E J1, J7, J9 |
| AC2  | web via third-party fixture (E2E); web via `twitterGot` and developer via twitter-api-v2 (unit, transport fixture) | E2E J2, J3, J10; `twitter-source.test.ts`                           |
| AC3  | web-shaped and developer-shaped legacy objects                                                                     | `twitter-normalize.test.ts`; output-schema validation in E2E J2/J3  |
| AC4  | memory cache; real adapters                                                                                        | `twitter-source.test.ts`; E2E J4                                    |
| AC5  | each code in §4.4                                                                                                  | `executor.test.ts`; E2E J5, J6                                      |
| AC6  | queued/running phases                                                                                              | `executor.test.ts`; E2E J6                                          |
| AC7  | dev server and production bundle                                                                                   | `index.test.ts`, `server.test.ts`; E2E J1, J6, J9                   |
| AC8  | env parsing and startup warnings                                                                                   | `config.test.ts`, `twitter-tools.test.ts`                           |
| AC9  | MCP disabled vs enabled; `/test/1`, user route, `/twitter/user`, `/twitter/keyword`                                | `app-bootstrap.test.tsx`; E2E J8                                    |
| AC10 | whole repository                                                                                                   | §5.4 inventory receipts                                             |
| AC11 | search and user tweets; web (E2E) and developer (unit)                                                             | `cursor.test.ts`, `twitter-source.test.ts`; E2E J10                 |
| AC12 | web and developer backends                                                                                         | `twitter-tools.test.ts` "get_tweet real adapter" cases (§5.4)       |

### 5.2 Task

**One coherent task (T1)** covers the adapter page/detail functions and cursor extraction, MCP cursor handling, the new modules, the deletions, config, docs, tests and E2E. There is no qualifying reason to split: every change shares one interface (`TwitterSource` / tool catalog), and parallel writers would conflict on `lib/mcp`, `lib/config.ts` and the tests. A consolidated review follows. Record baseline results (unit suite, typecheck, Worker build) at `f212dfdeb` before changes and compare them at the end. These baseline checks run directly (§5.4), not through qex.

### 5.3 Affected files

- **Modify:** `lib/routes/twitter/api/index.ts`, `lib/routes/twitter/api/web-api/api.ts`, `lib/routes/twitter/api/web-api/utils.ts` (`fetchTimelinePage`), `lib/routes/twitter/api/developer-api/api.ts`, `lib/routes/twitter/utils.ts` (`TWEET_DETAIL_PARAMS`), `lib/routes/twitter/tweet.ts` (use the constant), `lib/mcp/index.ts`, `server.ts`, `errors.ts` (+ `errors.test.ts`), `index.test.ts`, `server.test.ts`, `limiter.test.ts` (if touched), `test-harness.ts`, `lib/config.ts` (+ `config.test.ts`), `lib/app-bootstrap.tsx` (+ `app-bootstrap.test.tsx`), `lib/errors/index.tsx` (+ test), `lib/middleware/access-control.ts` (+ test), `lib/middleware/template.tsx` (+ test), `lib/registry.ts`, `lib/registry-dev.ts` (+ test), `scripts/e2e/mcp.mjs` (including a `--capability` mode: fixture + outbound guard + dev server + `tools/list` only), `scripts/e2e/fixture-upstream.mjs`, `docs/mcp-endpoint.md`, and `AGENTS.md` (MCP E2E section only: describe the new journeys, and replace "Install dependencies with `rsshub-setup` and run `pnpm build` as separate heavy jobs first" with: install and build directly before the run; only the E2E stack is qex-admitted. The `qex-e2e mcp` declaration stays at 2 CPU / 4 GiB / 15 min and is re-validated with `agent-job estimates --cwd <worktree>`).
- **Add:** `lib/mcp/cursor.ts` (+ `.test.ts`), `lib/mcp/executor.ts` (+ `.test.ts`), `lib/mcp/twitter-tools.ts` (+ `.test.ts`), `lib/mcp/twitter-source.ts` (+ `.test.ts`), `lib/mcp/twitter-normalize.ts` (+ `.test.ts`), and `scripts/e2e/fixtures/twitter-graphql/*.json` (synthetic response fixtures).
- **Delete:** see §4.8.
- **No tests under `lib/routes/`**. Adapter page/detail behavior (no result cache, cursor extraction, RSS variables unchanged) is tested from `lib/mcp/twitter-source.test.ts` against the real adapter modules with mocked transport (`twitterGot`/`ofetch`/twitter-api-v2 client) and a cache spy. Sibling-named test files satisfy the orphan guard.

### 5.4 Verification inventory

Unit and integration tests (Vitest; real MCP SDK client against the in-process endpoint; injectable `TwitterSource` or real adapters with mocked transport):

| Test file                          | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `twitter-tools.test.ts`            | AC1–AC2, AC8, AC12 (real-entry get_tweet cases, see below): tools/list snapshot, both eras, `MCP_TOOLS` subsets (all/subset/empty/unknown), unknown-tool for removed tools, per-argument mapping spies, schema rejections (empty/513-char query, bad user, non-numeric tweetId, limit 0/21, extra property)                                                                                                                                                                                           |
| `twitter-normalize.test.ts`        | AC3 (web and developer fixtures)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cursor.test.ts`                   | AC11: encode/decode round trip, binding mismatches, malformed tokens, every nextCursor rule (§2.6 steps 1–5), resume when `a` is missing                                                                                                                                                                                                                                                                                                                                                              |
| `twitter-source.test.ts`           | AC2, AC4 and AC11 at the adapter level: page/detail functions skip result caches and the developer snapshot (no read/write), keep the lookup cache, and leave the RSS path unchanged (same variables and cache keys); Bottom cursor from `TimelineAddEntries` and `TimelineReplaceEntry`; developer `meta.next_token` → `next_token`/`pagination_token`; `get_tweet` success through the real web `getUserTweet` + `gatherLegacyFromData`, with `twitterGot` mocked to return a synthetic TweetDetail |
| `executor.test.ts`                 | AC5–AC6: error classification and redaction, Retry-After, capacity, timeouts in both phases, cancellation, byte bound                                                                                                                                                                                                                                                                                                                                                                                 |
| `index.test.ts` / `server.test.ts` | AC7, including no dispatch dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `config.test.ts`                   | AC8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `app-bootstrap.test.tsx`           | AC9 (in-process): disabled never imports; enabled warning; `/mcp/feed`; byte-identical feeds                                                                                                                                                                                                                                                                                                                                                                                                          |
| reverted hook tests                | the pre-MCP behavior of errors, access-control and template                                                                                                                                                                                                                                                                                                                                                                                                                                           |

E2E `scripts/e2e/mcp.mjs` (rewritten, under `qex-e2e mcp`), with evidence in `assets/build/e2e/mcp-run-*`:

- Setup: a loopback fixture upstream acts as `TWITTER_THIRD_PARTY_API` and serves synthetic `UserByScreenName`, `UserByRestId`, `UserTweets`, `UserTweetsAndReplies` and `SearchTimeline` responses, paged with synthetic `cursor-bottom-*` entries (search page 2+ via `TimelineReplaceEntry`) and a final empty page. It records each request's decoded `variables`, including `cursor`, and can hold or fail requests (429 + Retry-After, 500, user-not-found). Environment: no `TWITTER_AUTH_TOKEN`, `CACHE_TYPE=memory`, a random `ACCESS_KEY`, `MCP_ENABLE=true`, and the user-route fixture from `e2e-smoke.mjs`.
- **Outbound guard:** the server child runs with a fail-closed guard for non-loopback hosts (e.g. an E2E-only `--import` preload that wraps the global fetch/undici dispatcher). Blocked attempts are recorded in `result.json`. GraphQL query-ID discovery (x.com / jsdelivr) is expected to be blocked and fall back to built-in IDs. The run fails if any non-loopback connection succeeds.
- Journeys (each step recorded):
    - J1 discovery in the legacy (SSE) and modern (JSON) eras.
    - J2 `twitter_search` operator/encoding round trip, normalization and limit.
    - J3 `twitter_user_tweets` defaults, `includeReplies`, `includeRetweets=false`, `@handle` and `+id`, and the profile.
    - J4 freshness and no RSS state (AC4, including a held RSS fetch).
    - J5 `twitter_get_tweet` → `source_config_missing`, with no request to X; unknown user → `invalid_parameter`.
    - J6 errors and limits: 429 → `retryAfterSeconds`; held → `timeout` in the running phase; `capacity_exceeded`; queued cancellation leaves the fixture unhit; schema-rejection text; Origin 403; GET 405; oversized body; removed tool unknown.
    - J7 restart with `MCP_TOOLS=twitter_search` → only that tool is listed.
    - J8 unchanged feeds with MCP disabled vs enabled (AC9).
    - J10 paging: search and user-tweet pages followed to the end. `limit: 5` resumes within the same upstream page (the fixture sees no new cursor), then moves to the next page (the fixture sees `variables.cursor`). No duplicate or missing ids across the whole walk. The end is an absent `nextCursor`. A search cursor used on user tweets or with a different query, and a malformed token (bad base64url/JSON, wrong version, wrong field type), return `invalid_cursor` with the fixture unhit. A well-formed token whose `c` was edited to another string reaches the fixture as `variables.cursor` with that exact value. The fixture answers an unknown cursor with an empty page, so the call succeeds with no `nextCursor`.
    - J9 production: J1, J2, J3, J5, J8 and J10 against `dist/index.mjs`. `--skip-production` marks J9 unrun and cannot pass acceptance.
- **Honest limits:** no live X/Twitter, developer API, Redis multi-process, HTTPS/proxy or replica behavior is verified. A `twitter_get_tweet` success is proven by real-entry integration tests with transport fixtures (AC12), not by the E2E, because `TweetDetail` cannot use the third-party API and the E2E makes no requests to X.

**Execution policy (authoritative: refreshed `~/.pi/agent/AGENTS.md` and the e2e-feature skill with `references/verifier.md`).** The qex allowlist is exhaustive: Gradle builds (none in this repository) and complete E2E stacks, including capability probes and reruns. Everything else runs **directly**, not queued, under the build lock that the orchestrator assigns: dependency install, unit tests, lint/format, typecheck, coverage, the Node build, the Worker build and Nix builds. The implementation worker and the orchestrator never load qex instructions or create queued jobs, and no queued gate is attached to the implementation worker or a reviewer. Only the independent verifier (`worker` on `magpie/gpt-6.1-sol:medium`, verification-only) reads `~/.config/qex/AGENT.md` and admits the E2E stack. Any selection that contains the E2E, including its prerequisites (the `pnpm build` bundle for J9), goes to that verifier as one graph. The verifier runs the prerequisites directly and queues only the E2E leaf. The `e2e-feature-run verify` / `e2e-verify` helper itself stays outside qex.

**Known mismatch with older repository prose.** The root `AGENTS.md` still says that `rsshub-setup` installs "under the shared queue", that setup/cold shell realization is a separate `heavy` job, and (MCP section) that install and `pnpm build` are "separate heavy jobs". The `devenv.nix` wrappers self-queue: `rsshub-setup` = `agent-job run heavy -- bash scripts/dev-setup.sh`, and `rsshub-build`/`rsshub-test` likewise. `scripts/run-hook.sh` wraps commit hooks in `agent-job run` when qex is available. Under the new policy, workers **do not use those queued wrappers**. They call the underlying commands directly (below). T1 updates only the MCP E2E paragraph of `AGENTS.md` (§5.3). The browser-smoke prose, the `devenv.nix` wrappers and `run-hook.sh` are existing repo tooling outside this feature and are left unchanged. The orchestrator decides how commit hooks run in its workflow. Dependencies are already present in this worktree (`node_modules` exists), so an install is needed only if the lockfile or environment identity changes.

#### Environment recipe and execution inventory

Host kazuki. Every command runs from the worktree root `W=/home/sinkerine/.paseo/worktrees/150zojav/quiet-pelican` inside the pinned shell `nix develop --impure -c …` (agents have no direnv; there is no `.env`). `<lock>` is the single worktree build lock from the orchestrator's recipe (the prior run used `$(git rev-parse --absolute-git-dir)/e2e-feature-build.lock`). Acquire it once per command and never nest it. Every check below except the E2E leaf runs **directly** under `<lock>`. They are serialized on that one lock because they share rewritten outputs (`assets/build/*`, `dist*/`, `coverage/`, scratch `node_modules`).

- **Generated-route prerequisite (`gen-routes`):** `pnpm run build:routes` writes `assets/build/{routes.json,routes.js,route-paths.ts,radar-rules.*,maintainers.json}`. Vitest needs `routes.json`; typecheck needs `route-paths.ts`. Run it first, and rerun it whenever `lib/routes/**` or `lib/registry*.ts` changes, which T1 does (`lib/routes/twitter/*`). The `build`, `build:lib` and `worker-build` scripts also run it internally. The orphan-file guard already exempts `test/twitter-client-transaction-id.test.ts`. New `lib/mcp/*.test.ts` files each need a same-basename sibling, or `build:routes` fails.
- **Redis helper (orchestrator-owned, run-local, `$RUN_DIR/with-redis.sh <cmd…>`):** required for every **full** unit run (baseline and final). `lib/middleware/cache.test.ts` contains live-Redis cases ("redis", "redis with quit", "redis with error") that use `REDIS_URL` (default `redis://localhost:6379/`) and fail without a server. The helper is the same as in the prior run:
    - obtain `redis-server` via `nix build --no-link --print-out-paths --inputs-from "$W" nixpkgs#redis`;
    - start it on a free loopback port with `--save '' --appendonly no` and a scratch dir under `~/.cache/dev-scratch/rsshub/<key>/verify/redis-<id>`;
    - wait for `PING` and export `REDIS_URL`;
    - run the command, then `SHUTDOWN NOSAVE`, remove only its own dir, and preserve the exit status.

    Focused T1 runs don't need it, since `lib/mcp` no longer has Redis cases once `dispatch.test.ts` is deleted.

- **Chromium:** the existing `lib/utils/playwright*.test.ts` unit cases use the shell's `CHROMIUM_EXECUTABLE_PATH`. The MCP E2E server env omits it.
- **Dependencies:** present (`node_modules` exists). A frozen install is needed only if the lockfile or shell identity changes: `bash scripts/dev-setup.sh`, run directly under `<lock>`. This is the script behind `rsshub-setup`, minus the queue wrapper. T1 adds no dependency.
- **Bounded workers:** Vitest `--maxWorkers=4`; eslint `--concurrency 2`; tsdown at default parallelism, one build at a time under `<lock>`. The E2E (verifier) runs one RSSHub process, SDK clients and the fixture upstream within the `qex-e2e mcp` claim (2 CPU / 4 GiB / 15 min). It must not overlap any build that rewrites `dist/` (J9 uses `dist/index.mjs`) or `assets/build/*`.
- **Files rewritten by checks:** `gen-routes` writes `assets/build/*`; vitest coverage writes `coverage/`; `build` writes `dist/`; `build:lib` writes `dist-lib/`; `worker-build` writes `dist-worker/` and `assets/build/routes-worker.js`; the Vercel config writes `src/`, which is **not git-ignored**, so it gets a scratch `--out-dir`; the E2E writes `assets/build/e2e/mcp-run-*`. There is no repository-wide formatter. Workers fix only their owned files: `pnpm exec oxfmt <files>`, `pnpm exec oxlint --type-aware --fix <files>`.

| Id               | Phase                                      | Who                            | Command (inside `flock --close <lock> nix develop --impure -c …` unless noted)                                                                                                                                                                                                                                                                          | Proves / notes                                                                                                                                                                                 |
| ---------------- | ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen-routes`     | pre, full, and after `lib/routes/**` edits | worker / orchestrator          | `pnpm run build:routes`                                                                                                                                                                                                                                                                                                                                 | prerequisite for all below                                                                                                                                                                     |
| `T1-unit`        | task gate (focused)                        | host gate                      | `pnpm exec cross-env NODE_ENV=test vitest run --maxWorkers=4 lib/mcp lib/config.test.ts lib/app-bootstrap.test.tsx lib/middleware/access-control.test.ts lib/middleware/template.test.ts lib/errors/index.test.ts lib/registry-dev.test.ts lib/registry.test.ts scripts/workflow/check-orphan-files.test.ts test/twitter-client-transaction-id.test.ts` | AC1–AC9, AC11, AC12 unit/integration                                                                                                                                                           |
| `baseline-units` | baseline at `f212dfdeb` before edits       | orchestrator                   | `$RUN_DIR/with-redis.sh pnpm exec cross-env NODE_ENV=test vitest run --coverage.enabled --maxWorkers=4 --reporter=default --reporter=junit --outputFile.junit=$RUN_DIR/junit-baseline.xml`                                                                                                                                                              | same discovery/config as `vitest:coverage`; rewrites `coverage/`                                                                                                                               |
| `units-coverage` | full                                       | orchestrator                   | same as `baseline-units` with `--outputFile.junit=$RUN_DIR/junit-feature.xml`                                                                                                                                                                                                                                                                           | full unit + coverage (AC10)                                                                                                                                                                    |
| `compare-junit`  | full                                       | orchestrator (direct, no lock) | `node $RUN_DIR/compare-junit.mjs $RUN_DIR/junit-baseline.xml $RUN_DIR/junit-feature.xml --allow-removed <list from AC10>`                                                                                                                                                                                                                               | exact AC10 baseline rule; also asserts the Redis cases executed                                                                                                                                |
| `format`         | full                                       | orchestrator                   | `pnpm run format:check`                                                                                                                                                                                                                                                                                                                                 | oxlint type-aware + oxfmt check                                                                                                                                                                |
| `eslint`         | full                                       | orchestrator                   | `pnpm exec eslint --concurrency 2 <all changed/added .ts/.tsx/.mjs files>`                                                                                                                                                                                                                                                                              | mirrors the pre-commit hook scope                                                                                                                                                              |
| `typecheck`      | full                                       | orchestrator                   | `pnpm typecheck`                                                                                                                                                                                                                                                                                                                                        | consumer check of every changed interface in `lib/**` (Twitter API types, config type, MCP modules, reverted hooks)                                                                            |
| `build-node`     | full; E2E prerequisite                     | verifier, in the E2E selection | `pnpm run build`                                                                                                                                                                                                                                                                                                                                        | consumer: Node server `dist/index.mjs` (the Nix package and the container's inner Node process)                                                                                                |
| `build-lib`      | full                                       | orchestrator                   | `pnpm run build:lib`                                                                                                                                                                                                                                                                                                                                    | consumer: `lib/pkg.ts` imports `@/app` → `app-bootstrap` (MCP mounted in package mode only if enabled), and the magpie plugin (`lib/magpie/*`, still imports `catalog`/`feed`); dts generation |
| `build-vercel`   | full                                       | orchestrator                   | `pnpm exec tsdown --config ./tsdown-vercel.config.ts --out-dir "$HOME/.cache/dev-scratch/rsshub/<key>/verify/vercel-src"`                                                                                                                                                                                                                               | consumer: `lib/server.ts` → `app-bootstrap` → dynamic `@/mcp`                                                                                                                                  |
| `worker-build`   | baseline + full                            | orchestrator                   | `pnpm run worker-build`                                                                                                                                                                                                                                                                                                                                 | consumer: `lib/app.worker.tsx` imports the reverted `@/errors`, `access-control` and `template`; must contain no `lib/mcp` / `@modelcontextprotocol` (grep `dist-worker/`)                     |
| `workerd`        | baseline + full                            | orchestrator                   | `pnpm run vitest:workerd`                                                                                                                                                                                                                                                                                                                               | `lib/utils/logger.worker.test.ts` and `playwright.worker.test.ts` import `@/config` (changed `mcp` block). Baseline result recorded first; final must match it                                 |
| `e2e-capability` | before substantial implementation          | verifier                       | `agent-job estimates --cwd "$W"`, then `agent-job run --e2e mcp -- nix develop --impure -c node scripts/e2e/mcp.mjs --capability` (fixture upstream + outbound guard + dev server + `tools/list`)                                                                                                                                                       | partial E2E stack, so queued; baseline feature assertions may fail                                                                                                                             |
| `e2e-mcp`        | full (once, new feature)                   | verifier                       | prerequisite `build-node` (direct, under `<lock>`), then `agent-job run --e2e mcp -- nix develop --impure -c node scripts/e2e/mcp.mjs`                                                                                                                                                                                                                  | J1–J10; the only queued leaf                                                                                                                                                                   |

Not applicable, with code evidence: `container-build` (`lib/container.ts` imports only `@cloudflare/containers` and types, not the app; its inner Node server is `build-node`); `build:docs` (no route metadata change; the twitter routes' `Route` objects are untouched); `vitest:fullroutes` (live-site route tests, excluded by D12). The selection `build-node` + `e2e-mcp` goes to the verifier as one graph; the `e2e-feature-run verify` / `e2e-verify` helper stays outside qex. Do not run `pnpm test:e2e:mcp` inside a reservation, because it wraps `agent-job run` again. Do not use `rsshub-setup`, `rsshub-build` or `rsshub-test`, because they self-queue non-allowlisted work.

#### `twitter_get_tweet` success proof (AC12)

`twitter_get_tweet` can't succeed in the E2E: `TweetDetail` isn't third-party-supported, and `twitterGot` sends it to the hard-coded `https://x.com/i/api` through an explicit undici `CookieAgent` dispatcher. Covering it there would need a TLS-intercepting proxy with a test CA, which is outside the approved no-X E2E scope. AC12 is instead proven by real-entry integration cases in `lib/mcp/twitter-tools.test.ts`:

- **Web backend.** Start the real endpoint via `test-harness.ts` (real `app`, loopback HTTP, real `@modelcontextprotocol/client` in both eras). Set env `TWITTER_AUTH_TOKEN=<random hex>`, `CACHE_TYPE=memory`, no third-party API. The only substitution is the transport: `vi.mock('undici', async (importOriginal) => { const m = await importOriginal(); return { ...m, fetch: fixtureFetch, default: { ...m.default, fetch: fixtureFetch } }; })`. The web adapter calls `undici.fetch` through the default import (`lib/routes/twitter/api/web-api/utils.ts:5`). `fixtureFetch` routes by pathname:
    - `/graphql/<id>/UserByScreenName` → `scripts/e2e/fixtures/twitter-graphql/user.json`;
    - `/graphql/<id>/TweetDetail` → `tweet-detail.json` (focal post + two replies + one ancestor);
    - anything else → it throws.

    It records the decoded `variables`. Before the call, the test seeds the memory cache with `twitter:cookie:<token>` (a serialized jar containing `auth_token` and `ct0`), so `token2Cookie` makes no `ofetch`, and with `twitter:gql-query-ids` (the gql-id-resolver `CACHE_KEY`), so `api.init()` makes no network discovery. Assertions:
    - the structured result has the focal `tweet.id` and a `thread` with the other posts;
    - `limit: 1` bounds `thread`;
    - `variables` equals `TWEET_DETAIL_PARAMS` + `focalTweetId`;
    - a fixture without the focal post gives `not_found`;
    - `fixtureFetch` saw only the two expected paths.

    The real `getTweetDetail`, `twitterGot`, `gatherLegacyFromData`, executor and normalizer all run.

- **Developer backend.** The same entry with `TWITTER_CONSUMER_KEY`/`SECRET` set. The transport fixture is `vi.mock('twitter-api-v2')`, with a `TwitterApi` class whose `.readOnly.v2.userByUsername`/`.v2.user` and `.readOnly.v2.get('tweets/<id>', …)` return fixture v2 JSON. This is the `TwitterApi` import at `lib/routes/twitter/api/developer-api/api.ts:3`. Assertions: focal tweet, empty `thread`, and the request path `tweets/<tweetId>`.
- These cases live in `twitter-tools.test.ts`, which is sibling-named, so the orphan guard is satisfied, and nothing goes under `lib/routes/`. Fake-`TwitterSource` tests stay only for executor edge cases (timeouts, capacity, byte bound).

#### Required documentation

- **DOC1** `docs/mcp-endpoint.md` rewritten for this design:
    - the three tools and their exact inputs, outputs and descriptions (§2.1–§2.3);
    - cursor paging, including the unsigned-token limitation of §2.6 class 3;
    - the error table (§4.4);
    - the config table (§4.7), with `MCP_TOOLS` and the removal of `MCP_ROUTES`/`MCP_MAX_ITEMS`, plus their startup warnings;
    - credentials per tool, the unchanged no-authentication warning and the Origin check;
    - the best-effort token-lock note (§4.2);
    - a client example including a paging loop (§2.5);
    - honest verification limits.

    Evidence: test-gate review against this list, and `format:check`.

- **DOC2** `AGENTS.md` MCP E2E paragraph (§5.3): the new journeys and the direct-prerequisite/queued-E2E-leaf policy. The `qex-e2e mcp` declaration is unchanged and re-validated by `agent-job estimates --cwd "$W"`.
- **DOC3** Agent-facing tool and parameter descriptions are exactly the §2.2 text, with the cursor additions. Evidence: the `tools/list` snapshot in `twitter-tools.test.ts` (AC1).

Per AGENTS.md, this E2E runs when the feature is added. Future pushes and deployments do not rerun it; the existing unit tests always run. The browser smoke (`qex-e2e browser`) is unaffected and not required.

## 6. Risks

- Importing `@/routes/twitter/api` from `lib/mcp` pulls twitter-api-v2 and undici cookie agents into the Node bundle. These are already present via the routes, so there is no new dependency. The Worker build must not reach `@/mcp`; the existing dynamic import is gated by `config.mcp.enable` and is verified by AC10.
- X's internal web API is not a supported contract, and X's automation rules still apply (as noted in the existing docs). Fresh reads raise upstream request volume compared with cached RSS; the defaults of concurrency 1 and queue 4 bound it.
- The developer-API backend bills a full page on every call, including every page.
- X's cursor entry shapes are not exercised anywhere in current code and are not verified live (§3). The fail-safe is to omit `nextCursor`. A third-party proxy may ignore `variables.cursor`; the repeated-cursor and empty-page rules then end paging rather than loop.
- Deep paging multiplies upstream requests. Each page still passes through the MCP limiter and the shared best-effort token lock (§4.2); neither serializes across processes.

## 7. Open decisions

None are blocking. r2 designer choices for the user to confirm: cursor paging is **not** offered on `twitter_get_tweet` (its thread stays first-page only; `TweetDetail` reply cursors live inside conversation modules and the developer backend has no thread); resume-after-id within a page so `limit < 20` loses nothing; the cursor is unsigned but bound to tool, backend and arguments. r1 items: R1 (remove `MCP_MAX_ITEMS`, `limit` 1–20), R2 (response-byte minimum 65536), R3 (warn on obsolete variables), R4 (warn when no backend is configured), and the repost representation (top-level fields describe the original post plus `retweetedBy`).

## 8. User approval record

- r1: **APPROVED** by the user ("Approve as written") on 2026-11-15 22:04 PST (UTC−08:00). Decisions D2/D3 (choice A), D5, D6, D7, D8 and D9, with designer choices R1–R5 and the repost representation. Not handed off.
- r1 reopened by the user after approval ("do we also support paging and offset and max limit?"); the user chose option 2: cursor paging, no offset (D13, D14).
- r2.1 (process-only correction, 2026-11-15): the originating tab relayed the refreshed `~/.pi/agent/AGENTS.md` and e2e-feature `SKILL.md` / `references/verifier.md` qex policy and asked for a procedural fix only. §5.2–§5.4 now run ordinary checks directly under locks, the independent verifier queues only the E2E leaf, and the self-queued wrappers are not used; the older repository prose mismatch is recorded. **Reason the approval is retained:** the e2e-feature skill allows a non-material clarification to keep the existing approval, with the reason recorded. Here the product design, tool catalog, schemas, paging, acceptance criteria, E2E journeys, task split and authorization boundaries are byte-for-byte unchanged; only how already-approved checks are executed changed, to comply with authoritative instructions. The originating tab confirmed that no new human approval is needed. This approval grants no implementation, deployment or merge authority to this tab.
- r2.2 (2026-11-15): the originating tab's handoff audit found that §2.6 (unsigned cursor) contradicted AC11/J10 ("tampered → `invalid_cursor`, X unhit"). The user chose "Keep unsigned; correct the criteria" (D15). Changes:
    - §2.6 now has three validation classes, and AC11/J10 are reworded to malformed/mismatched → `invalid_cursor`, with well-formed edits forwarded and not detected.
    - Routine readiness edits: §4.2 order (cursor validation before admission); removed the claim that the token lock serializes accounts (it is a best-effort lease); AC1–AC12 ids; a state-transition table and AC→evidence map; DOC1–DOC3; the full direct command inventory (generated-route prerequisite, Redis helper, bounded workers, rewritten files, build:lib/Vercel/Worker/workerd consumers, not-applicable reasons); AC12, a real-entry `twitter_get_tweet` proof with transport fixtures.
    - The tool catalog, schemas, paging semantics and authorization are unchanged.
    - r2.2 status: **APPROVED.** The user selected "Approve r2.2 as written" via `ask_user` in this design tab on 2026-11-15 23:18 PST (UTC−08:00), after reviewing the completed r2.2 plan. This approval covers the design only. It grants this tab no implementation, deployment, merge, remote-credential or live-Twitter authority.
- r2 status: **APPROVED.** The user selected "Approve r2 as written" in the design tab on 2026-11-15 23:05 PST (UTC−08:00). This includes D13, D14 and the r2 designer choices in §7: no paging on `twitter_get_tweet`, resume-after-id, and an unsigned cursor bound to tool, backend and arguments.
- This approval covers the design only. It does not authorize implementation from this tab, deployment, merging, remote credential setup or live Twitter testing.
