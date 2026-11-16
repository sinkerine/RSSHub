# RSSHub MCP endpoint

RSSHub can expose read-only feed discovery and fetching through an MCP Streamable HTTP endpoint at exactly `/mcp`. Enable it on a Node server with `MCP_ENABLE=true`. The feature is disabled by default. It uses the existing RSSHub feed pipeline, cache, route credentials and parameter processing; it does not add a browser or a second Twitter transport.

**The MCP endpoint has no authentication. `ACCESS_KEY` does not protect `/mcp`. Anyone who can reach it can read every allowlisted feed, including the configured Twitter account’s home timeline and likes.** Restrict access using a private network, VPN or an authenticating reverse proxy, and use HTTPS. Any credentials required by a proxy belong to that proxy. RSSHub ignores `Authorization` and `key`/`code`/`token` query parameters on `/mcp`.

Requests with an `Origin` header must exactly match `MCP_ALLOWED_ORIGINS`; the default accepts no browser origins. Requests without `Origin`, as typically sent by agents, are accepted. An unlisted Origin receives HTTP 403 with `{"error":"forbidden_origin"}` before MCP processing. This check is not authentication.

The endpoint runs in the Node development and production server, including `dist/index.mjs` used by the Nix package. The Vercel entry mounts the same app and is build checked; no deployment is performed. The Cloudflare Worker does not expose MCP. A container worker proxies the Node server inside its container, so that Node process can expose MCP. Package mode mounts MCP only if explicitly enabled. Existing `/mcp/feed/:type?` feeds remain separate.

## Configuration

Comma lists are trimmed and empty entries removed. Invalid integers, fractional values and values below the minimum use the default. `MCP_MAX_ITEMS` is capped at 100.

| Variable                 | Default                      | Bounds / meaning                                                  |
| ------------------------ | ---------------------------- | ----------------------------------------------------------------- |
| `MCP_ENABLE`             | `false`                      | Boolean; opt in to unauthenticated `/mcp`                         |
| `MCP_ROUTES`             | Eight Twitter patterns below | Comma-separated full registered route patterns; empty allows none |
| `MCP_MAX_CONCURRENCY`    | `1`                          | Integer ≥ 1; running MCP feed calls per process                   |
| `MCP_MAX_QUEUE`          | `4`                          | Integer ≥ 0; waiting MCP feed calls per process                   |
| `MCP_TIMEOUT`            | `50`                         | Integer ≥ 1; seconds, queue and execution combined                |
| `MCP_MAX_ITEMS`          | `20`                         | Integer 1–100; output item cap                                    |
| `MCP_MAX_RESPONSE_BYTES` | `262144`                     | Integer ≥ 4096; UTF-8 bytes of success structured content         |
| `MCP_ALLOWED_ORIGINS`    | empty                        | Comma-separated exact Origins, e.g. `https://agent.example`       |

Default route patterns, in configuration order:

```text
/twitter/user/:id/:routeParams?
/twitter/keyword/:keyword/:routeParams?
/twitter/list/:id/:routeParams?
/twitter/media/:id/:routeParams?
/twitter/tweet/:id/status/:status/:original?
/twitter/home/:routeParams?
/twitter/home_latest/:routeParams?
/twitter/likes/:id/:routeParams?
```

Patterns must resolve in the live registry. Unresolved entries are excluded with one startup-discovery warning each. Discovery loads only the top-level directories needed by the allowlist in development. Fetching uses RSSHub’s first matching registered feed route; a broad allowed parameter pattern cannot bypass a more specific excluded route. `/mcp`, `/api/*`, `/healthz`, `/metrics`, `/robots.txt` and `/` cannot be fetched.

## Tools

The server supports the legacy 2025 initialization handshake and the per-request `2026-07-28` protocol, using the official `@modelcontextprotocol/server@2.4.0` SDK. Modern exchanges use JSON responses; the SDK’s stateless legacy transport uses SSE, so reverse proxies must support SSE for legacy clients. Both tools declare input and output schemas and `readOnlyHint: true`. GET and DELETE `/mcp` return 405. POST bodies are limited to 65536 bytes. There is no persistent MCP session state.

`search_routes` accepts:

```ts
{ query?: string; limit?: number; offset?: number }
```

`query` is at most 200 characters; `limit` is an integer 1–50 (default 10); `offset` is an integer ≥ 0 (default 0). Nonempty queries use RSSHub’s catalog ranking. Empty queries list all resolved allowed routes sorted by path. Results have `{ routes, total, nextOffset? }`, with `nextOffset` only if more entries remain. Each route is:

```ts
{
  path: string; namespace: string; namespaceName: string; name: string;
  example?: string; description?: string; // description ≤ 500 characters
  parameters: Array<{
    name: string; optional: boolean; description?: string;
    default?: string; options?: string[];
  }>;
  requiresConfig: Array<{ name: string; optional: boolean }>;
}
```

Configuration names are metadata; their values are never included. Build a concrete path from a returned pattern and its parameters.

`fetch_feed` accepts:

```ts
{ path: string; limit?: number; content?: 'text' | 'html' | 'none' }
```

`path` must start with `/`, contain 1–2048 characters and resolve to an allowed route. Queries, fragments, whitespace, double slashes, backslashes and normalized dot segments (including `%2e`) are rejected. `limit` is an integer 1–`MCP_MAX_ITEMS`, default `min(20, MCP_MAX_ITEMS)`. `content` defaults to `text`: RSSHub’s HTML-to-text conversion. `html` returns processed HTML and `none` omits content. The result is:

```ts
{
  route: { path: string; namespace: string; name: string };
  requestPath: string;
  feed: {
    title: string; link?: string; description?: string;
    image?: string; language?: string; author?: string;
  };
  items: Array<{
    title?: string; link?: string; guid?: string;
    pubDate?: string; updated?: string; // ISO dates, absent when invalid/missing
    author?: string; categories?: string[];
    content?: string; contentFormat: 'text' | 'html' | 'none';
    contentTruncated: boolean;
    image?: string; enclosure?: { url: string; type?: string; length?: number };
  }>;
  itemCount: number; returnedCount: number;
  truncation: { items: boolean; content: boolean; bytes: boolean };
  snapshot: {
    cache: 'hit' | 'miss' | 'disabled'; builtAt: string;
    ttlMinutes: number; pagination: 'none';
  };
}
```

`itemCount` is the processed snapshot’s item count before MCP limits. `truncation.items` reports clipping by the requested item limit. Item content is at most 4000 characters; `contentTruncated` and aggregate `truncation.content` report clipping. HTML can end mid-markup. Trailing items are dropped until the structured result fits the byte bound, with `truncation.bytes: true`. If metadata alone exceeds the bound, fetching fails explicitly with `internal_error`. Input rejected by the advertised schema (including empty or overlong paths and invalid limits) produces SDK `Input validation error` text tool errors before dispatch. These SDK errors have `isError: true` and no structured error code. Paths within the schema bounds that fail syntax checks return the structured `invalid_arguments` error below.

Tool-produced successes and runtime errors have `structuredContent` and a text content block containing the identical JSON. SDK input-validation errors are excluded: they return `isError: true` with text only. The whole MCP response is approximately twice the configured structured-content byte bound, plus JSON escaping and protocol overhead. Feed pagination is always `none`; there is no feed cursor or next-page field. Discovery pagination is independent.

`snapshot.builtAt` is the RSSHub pipeline snapshot build time (`lastBuildDate`), preserved on cache hits. With caching disabled it is MCP completion time. It is **not an upstream fetch time**: route-level detail caches may contain older source data. The dispatcher forwards a bare path, without `format`, `limit`, `sorted` or filter queries, so it shares the default RSS reader’s feed-cache key. MCP limits are applied after the feed pipeline.

## Errors

Tool-produced runtime errors have `isError: true` and matching text/structured JSON as shown below. SDK input-validation errors return `isError: true` with `Input validation error` text, without this structured error object:

```ts
{ error: {
  code: string; message: string; retryable: boolean;
  retryAfterSeconds?: number; phase?: 'queued' | 'running';
} }
```

| Code                    | Retryable | Meaning                                                     |
| ----------------------- | --------- | ----------------------------------------------------------- |
| `invalid_arguments`     | false     | Invalid feed path syntax                                    |
| `route_not_allowed`     | false     | Excluded, recursive or non-feed path                        |
| `route_not_found`       | false     | Route raised NotFoundError                                  |
| `invalid_parameter`     | false     | Route rejected a parameter                                  |
| `source_config_missing` | false     | Source credentials/configuration missing                    |
| `access_denied`         | false     | Route raised RejectError                                    |
| `captcha_required`      | false     | Source requires CAPTCHA                                     |
| `upstream_rate_limited` | true      | Source returned 429, including Twitter’s error format       |
| `upstream_error`        | true      | Other source failure                                        |
| `request_in_progress`   | true      | Existing feed claim did not finish within its waiter budget |
| `empty_result`          | false     | Empty route without `allowEmpty: true`                      |
| `unsupported_result`    | false     | Redirect, raw Response or no item array                     |
| `capacity_exceeded`     | true      | Running and waiting capacity full                           |
| `timeout`               | true      | Queue/execution deadline; `phase` identifies which          |
| `internal_error`        | false     | Internal MCP processing failure                             |

`retryAfterSeconds` is included only when a rate-limit error exposes a valid `Retry-After` header (seconds or HTTP date). MCP never retries automatically. Messages use a fixed sentence plus at most 300 characters of safe detail. They omit stacks, URL userinfo and queries, and redact configured secrets of at least six characters under credential-related config names. Feed item content is source data and is not redacted; protect endpoint access accordingly. An empty success is returned only for a successful route explicitly allowing empty items.

## Concurrency and deployment limits

Admission is FIFO, bounded per process, with a single deadline covering queue wait and execution. Queue saturation fails immediately. Queued HTTP cancellation removes the queued task, so its route never runs. Cancellation or timeout of a running task returns to the caller but retains the concurrency slot until the feed pipeline settles; its result still populates the shared feed cache. A route that never settles retains its slot. Source HTTP requests have their own `REQUEST_TIMEOUT` and retry behavior.

The limiter covers MCP only. It does not serialize external RSS requests, other processes, cluster workers or replicas. `ENABLE_CLUSTER` gives each worker its own limiter. Strict account serialization across RSS and MCP would require changes at the Twitter transport boundary, which this feature does not make. Same-key cache coordination is available with memory and Redis; memory coordinates only one process. Other cache backends may reuse snapshots without atomic request claims.

The default routes require Twitter configuration (discover `requiresConfig` for details). The configured web transport uses X’s internal web API, which is not a supported third-party contract. X’s automation rules prohibit non-API automation; successful requests do not establish permission. See [X automation rules](https://help.x.com/en/rules-and-policies/x-automation) and the [official X API](https://docs.x.com/x-api). Only discovery and the real missing-configuration error are verified here for Twitter. No live Twitter/X request or authenticated pilot was performed. There are no write actions (post, reply, like or follow).

The lockfile changes when installing the MCP SDK. Refresh the Nix package `pnpmDeps` hash in `flake.nix` before a Nix deployment. This feature does not deploy or change that hash.

## Connecting and verification

Add an HTTP MCP server at `https://<host>/mcp` in your agent’s MCP settings. Any proxy-level credentials are the operator’s responsibility. This work does not configure an agent product.

A legacy initialization request, without RSSHub credentials:

```sh
curl https://rsshub.example/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"example","version":"1"}}}'
```

Using the real SDK client (install `@modelcontextprotocol/client@2.4.0` in your client project):

```js
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'feed-reader', version: '1.0.0' });
// To use the modern era, pass as the second Client argument:
// { versionNegotiation: { mode: { pin: '2026-07-28' } } }
await client.connect(new StreamableHTTPClientTransport(new URL('https://rsshub.example/mcp')));
try {
    console.log(await client.listTools());
    console.log(await client.callTool({ name: 'search_routes', arguments: { query: 'twitter' } }));
    console.log(await client.callTool({ name: 'fetch_feed', arguments: { path: '/twitter/user/_RSSHub', limit: 5 } }));
} finally {
    await client.close();
}
```

Repository verification uses `node scripts/e2e/mcp.mjs` under `agent-job run --e2e mcp`, after separate setup and production-build jobs. Evidence is retained in `assets/build/e2e/mcp-run-*`. The journey uses loopback fixtures for successful feeds, output bounds, concurrency, timeouts, cache sharing, aborts, access controls and both protocol eras, plus the production Node bundle. `--skip-production` is for development diagnostics; it marks P1 unrun and cannot pass final acceptance. Redis integration runs with the unit suite and a local Redis service. Existing browser smoke remains a separate `browser` E2E check. No live site, HTTPS/proxy deployment or multiple-replica behavior is claimed by these checks.
