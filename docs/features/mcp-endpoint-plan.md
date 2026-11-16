# Plan: remote MCP endpoint for RSSHub (`mcp-endpoint`)

Status: **final**. Finalized after required human input: the user decided that MCP has no authentication (see
[Decision record](#decision-record-human-input-and-approval)). No approval of the whole plan was requested or given.

- Worktree: `/home/sinkerine/.paseo/worktrees/150zojav/quiet-pelican`, branch `quiet-pelican` (re-read with
  `git branch --show-current`; Paseo may rename it). Base ref `refs/remotes/origin/master`, base commit
  `5b2078027ed49763fb884401c6997c911652c7e7`. Clean at preflight. Workspace `wks_453e97694692b4c7`.
- Source handoff: `/home/sinkerine/.paseo/uploads/upload_ee97aff5-f676-48ff-a911-2df3be48b161/rsshub-mcp-handoff.md`
  (architecture there is a proposal; everything below was re-verified against the current checkout).
- Out of scope / not authorized: deployment, remote credential configuration, configuring any user agent, live
  Twitter/X requests or claims, changes to Twitter transport/token locking, write actions (post/reply/like/follow),
  changes to the Nix flake package hash.

## Decision record: human input and approval

Decision: **finalized after required human input.**

- **Revision 1** (autonomous): the plan was first finalized without human input. The request was explicit; the
  remaining choices (SDK, allowlist, limits, error taxonomy) are reversible, opt-in, deployment-free and within the
  handoff's recommendations.
- **Revision 2**, orchestrator blocker: unchanged HEAD cannot run `build:routes` (finding 11). Resolved autonomously
  by the minimal guard repair D17 and the Phase A baseline checkpoint. No requirement changed, so no human input was
  needed.
- **Revision 2**, user input (2026-11-15):
    - Mid-design, the user wrote "don't require authkey for the mcp". That reverses the request's "authenticated
      endpoint" and is ambiguous (drop the MCP token, or just don't tie MCP to `ACCESS_KEY`), so the design agent asked
      with `ask_user`.
    - Options offered: token optional; no MCP auth at all; keep the token but not `ACCESS_KEY`. The user answered
      **"No MCP auth at all"**.
    - Resolution (D6): `/mcp` has no authentication. `MCP_ENABLE=true` always mounts it unauthenticated. The `Origin`
      check stays. Access control is the operator's network/reverse-proxy responsibility. `ACCESS_KEY` does not
      protect `/mcp`.
    - Consequence, documented in DOC3 and recorded here: anyone who can reach `/mcp` can read every allowlisted feed,
      including the configured Twitter account's home timeline and likes. The plan does not add any auth back.
- The user did not ask to review or approve the whole plan. If they do, the plan is updated and `PLAN_READY` is
  re-sent with the accurate status.

## Verified current-source findings (basis for the design)

1. **Global feed middleware.** `lib/app-bootstrap.tsx` applies `trimTrailingSlash, compress, jsxRenderer, logger,
   trace, honeybadger, sentry, accessControl, debug, template, header, antiHotlink, parameter, cache` with
   `app.use(...)` to _every_ path, then mounts `registry` and `/api`. Anything mounted after them inherits all of it.
    - `lib/middleware/cache.ts` has no bypass for unknown paths: every request to `/mcp` would compute one cache key
      (`/mcp:rss`), claim `rsshub:path-requested:<hash>` on memory/Redis, and concurrent POSTs would wait 6 s × 10 and
      fail with `RequestInProgressError`. `lib/middleware/header.ts` would merge `Cache-Control: public,max-age`,
      `Access-Control-Allow-Methods: GET`, `Content-Type: application/xml` into MCP responses (Hono `set res` merges
      prepared headers). **MCP must be registered before this stack.**
    - Hono composes matching handlers in registration order; a handler returning a `Response` without `next()` ends the
      chain, so `app.all('/mcp', …)` registered right after `trimTrailingSlash()` bypasses the feed stack.
2. **Path collision.** The `mcp` namespace (`lib/routes/mcp/feed.ts`, MCP.so submissions feed) only registers
   `/mcp/feed/:type?`. Exact `/mcp` currently 404s, so an exact-path endpoint does not shadow it.
3. **Execution path.** `registerRssRoutes` wraps `route.handler(ctx)`; returns `Data`, a `Response`, or nothing.
   Route handlers expect a Hono context and depend on middleware (`parameter` post-processing, `cache` claim/storage),
   so direct `route.handler()` calls are not equivalent. `lib/pkg.ts` already performs in-process `app.request(path)`
   and `template.tsx` returns raw `Data` JSON when `config.isPackage`. `errors/index.tsx` turns thrown errors into an
   HTML page (or `{error:{message}}`), losing the error class — MCP needs a structured error channel.
4. **Access control.** `access-control.ts` requires `?key=`/`?code=` on every non-trivial path when `ACCESS_KEY` is set;
   `logger` logs `METHOD path` (path + query). Internal dispatch must therefore not put credentials in the URL.
5. **Cache semantics.** Feed cache key = `xxh64(path + ':' + (query.format || config.format) + limit? + sorted? +
   filtered?)`. A request with _no query_ produces the same key as a default RSS reader request (e.g. Miniflux). The
   cache middleware stores the route's raw `Data` after `await next()` and stamps `data.lastBuildDate = now()` (time
   the pipeline finished building the snapshot); hits set header `RSSHub-Cache-Status: HIT` and keep the stored
   `lastBuildDate`. Atomic claim coordination exists only when `globalCache.supportsAtomicClaims` (memory, Redis).
   In `NODE_ENV=test` the waiter polls once after 3 s; otherwise every 6 s up to 10 times.
6. **Registries.** `lib/registry.ts`: production → `assets/build/routes.js` (metadata + lazy `module` loaders); test →
   `assets/build/routes.json` (handlers imported on demand); dev → `createDevRegistry` lazily loads one top-level
   `lib/routes/<dir>` per first request into a separate sub-app (`registry-dev.ts`); `ensureAllLoaded()` imports every
   directory. User routes (`USER_ROUTES_PATH`, `.mjs`) are merged into `namespaces` and registered on the main app.
   Sub-app errors are rethrown to the outer `onError` with the outer context.
7. **Twitter.** `lib/routes/twitter/api/index.ts` picks web API when `TWITTER_AUTH_TOKEN` or
   `TWITTER_THIRD_PARTY_API` is set, else developer API, else a stub whose `init()` throws
   `ConfigNotFoundError('Twitter API is not configured')` before any network I/O. Web API `init()` resolves GraphQL
   query ids by fetching `x.com` and `cdn.jsdelivr.net`, so a third-party-API fixture cannot be hermetic. Rate limits
   surface as `Error('Twitter API error: 429')` (plain `Error`) from `twitterGot`; `ofetch` errors are `FetchError`
   with `statusCode`/`response`. Token transport is undici in-process; no Chromium in the request path.
8. **SDK (verified on npm, 2026-11-15).** `@modelcontextprotocol/server@2.4.0` (deps: `zod ^4.2.0`,
   `@modelcontextprotocol/core@2.4.0` which depends only on zod; Node ≥ 20) exports `createMcpHandler(factory,
   options)`: web-standard `fetch(request, {authInfo})`, a fresh server per HTTP request, serves the 2026-07-28
   per-request protocol and (default `legacy: 'stateless'`) 2025-era stateless traffic; GET/DELETE → 405;
   `maxRequestBodySize` default 4 MiB; no auth/Origin validation of its own. `McpServer.registerTool(name,
   {inputSchema: z.object(...), outputSchema, annotations}, cb(args, ctx))`; `ctx.mcpReq.signal: AbortSignal`;
   input-validation failures become `isError` text results ("Input validation error: …"); output validation is
   skipped when `isError: true`. `@modelcontextprotocol/client@2.4.0` defaults to the 2025 `initialize` handshake
   (`versionNegotiation.mode: 'legacy'`) and can pin `{ pin: '2026-07-28' }`. The v1 monolith
   `@modelcontextprotocol/sdk@1.32.2` pulls express/cors/raw-body and is not chosen. `@hono/node-server@2.1.6` aborts
   `Request.signal` with "Client connection prematurely closed." when the client disconnects. Repo zod `4.6.7`,
   hono `4.13.16` are compatible.
9. **Existing tooling.** `lib/magpie/catalog.ts` (`createCatalog`, scoring search over namespaces) and
   `lib/magpie/feed.ts` (`htmlToText`) are upstream helpers for the local magpie plugin; reusable, unchanged.
   `lib/routes/test/index.ts` (`/test/:id/:params?`, in every registry) deterministically produces
   `config-not-found-error`, `invalid-parameter-error`, `captcha-error`, `error`, `redirect`, `empty`,
   `allow_empty`, `slow` (1 s), `slow4` (4 s), `long`, plain 5 items.
10. **Environment.** Worktree has no `node_modules`, `.direnv`, or `assets/build/*`; outer PATH lacks pnpm/Chromium.
    Nix shell (`nix develop --impure`) provides Node 26, pnpm 12, Chromium (`CHROMIUM_EXECUTABLE_PATH`). Vitest needs
    `assets/build/routes.json` (from `pnpm build:routes`); typecheck needs `assets/build/route-paths.ts`. The existing
    unit suite contains live-Redis cases (`lib/middleware/cache.test.ts` "redis", default `REDIS_URL`) and Chromium
    cases (`lib/utils/playwright*.test.ts`); CI supplies a Redis service. `pre-commit` hooks rewrite staged files
    (`oxlint --fix`, `eslint --fix`, `oxfmt`, `format-description`) and run `typecheck`. `tsdown-vercel.config.ts`
    writes to `src/`, which is **not** git-ignored.
11. **Orphan-file guard blocks `build:routes` on unchanged HEAD** (orchestrator observation 2026-11-15, log
    `$RUN_DIR/verification/gen-routes-1794790983558307819.log`).
    - `scripts/workflow/build-routes.ts` throws when `findOrphanFiles()` (`scripts/workflow/check-orphan-files.ts`)
      returns anything.
    - That function scans `lib`, `spec`, `specs`, `test`, `tests` and reports, as `deprecated`, _every_ file not under
      `lib/` (or under `lib/routes-deprecated/`). It also reports any `lib/**/*.{test,spec}.*` without a same-directory
      same-basename source file, and any test under `lib/routes/`.
    - The fork's commit `280d2a67c` added the tracked `test/twitter-client-transaction-id.test.ts`, which unit-tests
      `lib/routes/twitter/api/web-api/client-transaction-id.ts` with mocks. So `build:routes`, and with it vitest,
      typecheck and every build, fails at base commit `5b20780` before any test runs.
    - The test must stay discovered. It must not be removed, skipped or moved under `lib/routes`. Moving it elsewhere
      under `lib/` would violate the same-basename rule.
    - Consequence for this plan: every new `lib/**/*.test.ts` must have a same-directory, same-basename source file.
      This is why the MCP integration tests are named `index`, `dispatch` and `server`.

## Goal and acceptance criteria

### Target behavior

An operator sets `MCP_ENABLE=true` on a Node RSSHub server. The same process then serves an MCP Streamable HTTP
endpoint at exactly `POST /mcp`, with **no authentication** (user decision, D6). The endpoint rejects disallowed
browser `Origin`s, and the operator restricts access at the network or reverse proxy. Agents can connect with either the 2025-era (`initialize`) or the 2026-07-28 protocol. Two tools are exposed:

- `search_routes`: bounded, paginated discovery of the **allowlisted** feed routes (default: eight read-only Twitter
  routes), using existing registry metadata.
- `fetch_feed`: executes one allowlisted route through RSSHub's **existing** feed pipeline in-process (middleware,
  parameter processing, cache and same-key coordination). Results are bounded, structured items with explicit
  truncation, snapshot/cache freshness metadata, and a closed error taxonomy.

Execution is admitted through a bounded per-process concurrency limiter and queue. RSS/Atom/JSON feed endpoints and
access control behave exactly as before. Source credentials never appear in tool results. The feature is disabled by
default and adds no browser dependency.

### Acceptance criteria

Common fixtures for evidence: `F-user` = user-route fixture `scripts/e2e/fixtures/e2e-mcp.mjs` (namespace `e2e-mcp`)
backed by the counting/holding loopback upstream `scripts/e2e/fixture-upstream.mjs`; `F-test` = built-in
`/test/:id/:params?` route; `F-tw` = real Twitter routes with no Twitter credentials configured. "Integration test" =
vitest file that starts the **real** RSSHub app (`@/app`) on `@hono/node-server` at `127.0.0.1:0` and drives it with
the **real** `@modelcontextprotocol/client@2.4.0` over HTTP (no fake for RSSHub code, SDK server, or client).
"E2E Sn" = step of the journey in [E2E journey](#e2e-journey), run under qex `--e2e mcp`.

- **AC1 — Opt-in mounting at exactly `/mcp`.**
    - With `MCP_ENABLE` unset (default), `GET/POST/DELETE /mcp` responses are identical in status and body to the baseline
      not-found response, and `lib/mcp` is never imported. Proof: the test registers `vi.doMock('@/mcp', factory)`
      before `await import('@/app')` and asserts the mock factory never ran.
    - With `MCP_ENABLE=true`, the endpoint is mounted with no credential requirement and one warn log line `MCP
      endpoint mounted at /mcp without authentication; restrict access at the network or reverse proxy` is emitted.
      `ACCESS_KEY`, when set, is neither required nor checked for `/mcp`.
    - `POST /mcp/feed` is not handled by MCP: it gets the router's normal non-MCP response, and the
      `/mcp/feed/:type?` route registration is unchanged.
    - Entry paths: `app.request` (test mode) and real HTTP server.
    - Evidence: `lib/app-bootstrap.test.tsx` (new cases `mcp disabled`, `mcp enabled logs unauthenticated warning`,
      `mcp enabled does not shadow /mcp/feed`); E2E S2, S3, P1.
- **AC2 — No authentication; Origin gate before any MCP or route work.**
    - With `ACCESS_KEY` set, these requests all reach the SDK and succeed (`initialize` 200 / `tools/call` result):
        - no `Authorization` header;
        - an arbitrary `Authorization: Bearer anything` header (ignored, never logged);
        - an arbitrary `?key=wrong` query (ignored).
    - A request with an `Origin` header not listed in `MCP_ALLOWED_ORIGINS` gets `403` JSON
      `{"error":"forbidden_origin"}`. No MCP server instance is created and no route executes (factory-invocation
      counter 0, upstream hit counter unchanged, no `mcp tool` log line).
    - A request with no `Origin`, or with a listed origin, reaches the SDK.
    - Entry paths: legacy-era POST, modern-era POST, GET, DELETE.
    - Evidence: integration test `lib/mcp/index.test.ts` › `access`; E2E S2.
- **AC3 — Real MCP protocol in both eras.**
    - Without credentials, the real client in default legacy mode completes `initialize` (server info name `rsshub`,
      capability `tools`). In pinned `2026-07-28` mode it completes `server/discover`.
    - In both eras, `tools/list` returns exactly `fetch_feed` and `search_routes`, each with `inputSchema`,
      `outputSchema` and `annotations.readOnlyHint === true`, and `tools/call` returns results for both tools.
    - `GET /mcp` and `DELETE /mcp` return `405`.
    - Entry paths: legacy era, modern era, test-mode registry, dev-mode registry (E2E), production build (E2E P).
    - Evidence: `lib/mcp/index.test.ts` › `protocol` (both eras); E2E S3, S4, P1.
- **AC4 — Discovery of allowlisted routes only, across registries.**
    - `search_routes` returns only routes that are both in `MCP_ROUTES` and resolved in the live registry.
    - With the default `MCP_ROUTES`, `query:"twitter"` returns exactly the eight default patterns (D7); never
      `/twitter/trends/:woeid?` or `/twitter/spaces/:username`.
    - Each entry has `path` (full pattern), `namespace`, `namespaceName`, `name`, `example?`, `description?` (≤ 500
      chars), `parameters[]` (name, optional, description?, default?, options?) and `requiresConfig[]`
      (`{name, optional}` only, never values).
    - Pagination is `offset`/`limit` (1–50, default 10) with `total` and `nextOffset` only when more remain. An empty
      `query` lists all allowed routes sorted by `path`.
    - Unresolvable `MCP_ROUTES` entries are excluded and produce one warn log line each (`MCP route not found in
      registry: <pattern>`).
    - Entry paths: test-mode registry (`routes.json`); production registry (`assets/build/routes.js` metadata, no route
      module imported); dev lazy registry (only allowlisted top-level directories loaded, not `ensureAllLoaded`); user
      routes; production server build.
    - Evidence: `lib/mcp/allowlist.test.ts` (real `routes.js`/`routes.json`), `lib/registry-dev.test.ts`
      (`ensureNamespacesLoaded` loads only the requested directories), `lib/mcp/index.test.ts` › `search_routes`;
      E2E S5, P1.
- **AC5 — `fetch_feed` runs the existing pipeline and returns the documented structure.**
    - For an allowlisted path, the result's `structuredContent` validates against the declared output schema (D10), and
      its `content[0].text` is the same JSON.
    - Its items equal, in order, the items RSSHub's own JSON pipeline produces for the same path: compare titles, links
      (absolute), guids and pubDates against `app.request(path + '?format=json')` from the same server, and the
      `parameter` middleware's sorting and link resolution must be visible.
    - Entry paths: legacy and modern eras; `F-user` (dev E2E and test-mode integration); `F-test` `/test/1`
      (integration); production build with `F-user` (E2E P1).
    - Evidence: `lib/mcp/index.test.ts` › `fetch_feed success`; `lib/mcp/result.test.ts` (mapping of real
      pipeline output); E2E S6, P1.
- **AC6 — Cache reuse and same-key coordination with existing feed clients.**
    - (a) MCP → MCP: the second call to the same path reports `snapshot.cache === "hit"` with the same `builtAt`, and the
      upstream hit count stays 1.
    - (b) RSS → MCP: after a default RSS GET of a path, MCP reports `"hit"` with no new upstream hit.
    - (c) MCP → RSS: after MCP, the default RSS GET returns `RSSHub-Cache-Status: HIT` with no new upstream hit.
    - (d) A concurrent RSS GET (holding the claim) and MCP call for the same held path produce exactly one upstream
      request, and MCP returns `"hit"` after release.
    - MCP never forwards `format`, `limit`, `sorted` or filter query parameters.
    - Entry paths: memory cache (integration + E2E); Redis cache (integration, run with the verification Redis;
      `describe.runIf(process.env.REDIS_URL)`, and the test gate requires the junit to show these cases executed, not
      skipped); cache disabled (`CACHE_TYPE=` empty → `snapshot.cache === "disabled"`).
    - Evidence: `lib/mcp/dispatch.test.ts`; E2E S6, S13.
- **AC7 — Bounded output with explicit truncation; honest freshness; no invented pagination.**
    - `limit` is 1..`MCP_MAX_ITEMS`; the default is `min(20, MCP_MAX_ITEMS)`; out-of-range values give an
      `Input validation error` tool error.
    - `itemCount` is the snapshot size and `returnedCount` the number of returned items. `truncation.items` is true iff
      `returnedCount < itemCount` because of `limit`.
    - Each item's content is at most 4000 characters, with `contentTruncated: true` when clipped.
    - When `JSON.stringify(structuredContent)` would exceed `MCP_MAX_RESPONSE_BYTES` (UTF-8), trailing items are
      dropped until it fits and `truncation.bytes === true`.
    - Every result has `snapshot.pagination === "none"`, and no cursor or next-page field exists.
    - `snapshot.builtAt` is the pipeline build time (`lastBuildDate` stamped by the cache middleware, or MCP's
      completion time when the cache is disabled). It is documented as not being an upstream fetch time.
    - Entry paths: `content` = `text` | `html` | `none`; limit-truncated; byte-truncated; untruncated.
    - Evidence: `lib/mcp/result.test.ts`; `lib/mcp/index.test.ts` › `bounds`; E2E S6, S7.
- **AC8 — Bounded concurrency and queue with explicit saturation and recovery.**
    - With `MCP_MAX_CONCURRENCY=1` and `MCP_MAX_QUEUE=1`: call A runs on a held path and call B queues. Call C fails
      immediately with error code `capacity_exceeded` (`retryable: true`) in under 1 s, and its route never runs.
    - After release, A and B succeed in FIFO order (upstream order A, then B), and a subsequent call succeeds.
    - A task that throws releases its slot.
    - Entry paths: tools/call in both eras (integration); legacy (E2E).
    - Evidence: `lib/mcp/limiter.test.ts` (unit, all transitions); `lib/mcp/server.test.ts` ›
      `capacity`; E2E S11.
- **AC9 — Deadline and slot-holding semantics.**
    - Each call has one deadline of `MCP_TIMEOUT` seconds covering queue wait and execution. On expiry the call
      returns error code `timeout` with `phase: "running"` or `phase: "queued"`.
    - A timed-out queued call's route never runs.
    - A timed-out running call keeps its concurrency slot until the dispatched route settles, so a new call queues
      rather than starting. The new call starts only after the held route completes, and then succeeds.
    - The timed-out run's result is still written to the feed cache: a later call for that path reports `"hit"`.
    - Entry paths: running timeout, queued timeout, post-timeout recovery.
    - Evidence: `lib/mcp/limiter.test.ts`; `lib/mcp/server.test.ts` › `timeout`; E2E S12.
- **AC10 — Cancellation by HTTP abort.**
    - When the client aborts the HTTP request of a queued `fetch_feed` call, the call leaves the queue. The next call
      queues instead of failing with `capacity_exceeded`, and the aborted call's route never runs (upstream count for
      its path stays 0).
    - Aborting a running call frees nothing early (slot held until settle, as in AC9).
    - Entry paths: legacy-era raw HTTP POST with `AbortController` (integration + E2E); limiter unit (queued and
      running abort).
    - Evidence: `lib/mcp/limiter.test.ts`; `lib/mcp/server.test.ts` › `cancel`; E2E S14.
- **AC11 — Distinguishable failures; empty only when backed by success.**
    - Each condition yields an `isError: true` result whose `structuredContent.error.code` is the listed code (D9). No
      condition produces a success result with empty items unless the route returned `allowEmpty: true` with zero items
      (then success with `items: []` and `itemCount: 0`).

        | Condition                                                                     | Error code              |
        | ----------------------------------------------------------------------------- | ----------------------- |
        | invalid path syntax                                                           | `invalid_arguments`     |
        | non-allowlisted, recursive, or non-feed path                                  | `route_not_allowed`     |
        | `NotFoundError`                                                               | `route_not_found`       |
        | `InvalidParameterError`                                                       | `invalid_parameter`     |
        | `ConfigNotFoundError` (incl. real Twitter without credentials)                | `source_config_missing` |
        | `RejectError`                                                                 | `access_denied`         |
        | `CaptchaError`                                                                | `captcha_required`      |
        | 429 via `FetchError.statusCode`, `response.status`, or message `… error: 429` | `upstream_rate_limited` |
        | other thrown errors                                                           | `upstream_error`        |
        | `RequestInProgressError`                                                      | `request_in_progress`   |
        | `this route is empty` from `parameter` middleware                             | `empty_result`          |
        | handler returned a `Response`/redirect/no item array                          | `unsupported_result`    |
        | queue full                                                                    | `capacity_exceeded`     |
        | deadline                                                                      | `timeout`               |
        | MCP-internal failure                                                          | `internal_error`        |

    - `upstream_rate_limited` includes `retryAfterSeconds` only when the error exposes `Retry-After`.
    - Entry paths: `F-test` ids `config-not-found-error`, `invalid-parameter-error`, `captcha-error`, `error`,
      `redirect`, `empty`, `allow_empty`; `F-user` `/fail/*`, `/empty`, `/empty-ok`, `/raw`; `F-tw`
      `/twitter/user/_RSSHub`; a real `ofetch` 429 with `Retry-After` (msw) for the classifier.
    - Evidence: `lib/mcp/errors.test.ts`; `lib/mcp/index.test.ts` › `errors`; E2E S8, S9.
- **AC12 — No arbitrary execution or recursion.**
    - These paths return `invalid_arguments` or `route_not_allowed` without dispatching (handler counter / upstream
      counter / server log show no `GET <path>`):
        - a registered but non-allowlisted route (`/twitter/trends/23424856`);
        - `/mcp`, `/api/namespace`, `/healthz`, `/`;
        - a path with a query (`?format=json`) or fragment;
        - dot segments (`/e2e-mcp/../api/namespace`, `%2e%2e`);
        - a non-`/`-prefixed or empty path, or more than 2048 chars.
    - A path whose first-matching registry route (RSSHub's own route order) is not allowlisted is rejected, even if
      some allowlisted pattern also matches it.
    - Entry paths: integration (test-mode registry), E2E (dev registry).
    - Evidence: `lib/mcp/allowlist.test.ts`; `lib/mcp/index.test.ts` › `restriction`; E2E S10.
- **AC13 — Existing feed behavior unchanged.**
    - (a) The full existing unit suite meets criterion V1.
    - (b) With MCP enabled, external RSS and JSON Feed responses for `/test/1` and an `F-user` path are byte-identical
      to the same requests with MCP disabled. Exceptions: the `lastBuildDate`/`updated` values; the `ETag` header,
      because it hashes data without `lastBuildDate` and must be equal; and `/mcp` itself.
    - (c) With `ACCESS_KEY` set, external requests without key/code still get `403`, with key/code still `200`.
      Internal-dispatch state cannot be set by any HTTP input (header, query, body); the marker is a module-private
      `Symbol` in `ctx.env`.
    - (d) The existing browser smoke `scripts/e2e/run.mjs` passes.
    - Entry paths: test-mode `app.request`, real HTTP (E2E dev).
    - Evidence: V1 junit comparison; `lib/app-bootstrap.test.tsx` › `feeds identical with mcp enabled`;
      `lib/middleware/access-control.test.ts`, `template.test.ts`, `lib/errors/index.test.ts` (internal-marker cases
      plus unchanged external cases); E2E S1, S15; check `e2e-browser-smoke`.
- **AC14 — No credential exposure.**
    - No MCP HTTP response body (discovery, results, errors) contains any configured secret. Covered: `ACCESS_KEY`,
      and every string reachable in `config` under a key matching
      `/token|secret|password|passwd|cookie|key|auth|session|credential/i` (≥ 6 chars).
    - Error messages strip URL userinfo and query strings.
    - Server logs never contain the value of an `Authorization` header sent to `/mcp`. MCP-originated internal
      requests are logged without `key=`, `code=` or `token=` query parameters.
    - Feed item content is source data and is not redacted (documented).
    - Entry paths: error from a route embedding `ACCESS_KEY` and a `?api_key=` URL (`F-user` `/fail/secret`); a
      `FetchError`-shaped message with URL query (`/fail/rate-limit`); discovery of routes with `requireConfig`;
      requests carrying a dummy `Authorization` header.
    - Evidence: `lib/mcp/errors.test.ts` › `redact`; `lib/mcp/index.test.ts` › `no secrets` (scans every raw
      response body captured through the client's `fetch` option, plus the log spy); E2E S16.
- **AC15 — No browser dependency introduced.**
    - No module under `lib/mcp/` statically or dynamically imports `@/utils/playwright*`, `patchright`, or
      `puppeteer`.
    - The E2E server runs without `CHROMIUM_EXECUTABLE_PATH`, and sampled process listings of its descendants contain
      no `chrom` process.
    - Evidence: `lib/mcp/allowlist.test.ts` › `no browser imports` (parses import specifiers of every `lib/mcp/*.ts`
      source); E2E S16.
- **AC16 — Prerequisite guard repair (D17).**
    - `pnpm run build:routes` succeeds on the tracked tree, including `test/twitter-client-transaction-id.test.ts`.
    - That test remains in default vitest discovery and passes. In the baseline and final junit it appears as an
      executed, passing case.
    - The guard still reports each of these, in a temporary root passed to the function:
        - any other file under `test/`, `tests/`, `spec/` or `specs/`;
        - a `lib/` test with no same-basename source;
        - a test under `lib/routes/`;
        - a file under `lib/routes-deprecated/`.
    - Its result for the real repository root is exactly `[]` after the repair. It is exactly
      `['test/twitter-client-transaction-id.test.ts']` before the repair (red).
    - Entry paths: `findOrphanFiles()` on the real root; on a temporary root; the `build:routes` CLI.
    - Evidence: `scripts/workflow/check-orphan-files.test.ts`; checks `gen-routes`, `baseline-units` and
      `units-coverage`, whose junit contains the root test case.

### Introduced state, lifecycle, retry and concurrency transitions

| #   | Transition                                                                                                   | Covered by                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| X1  | limiter idle → running → idle (success and thrown task)                                                      | `limiter.test.ts` › `releases on success/throw`; AC8                         |
| X2  | running full → queued (FIFO) → running on release                                                            | `limiter.test.ts` › `fifo`; AC8                                              |
| X3  | queue full → immediate `capacity_exceeded`, no state change                                                  | `limiter.test.ts` › `rejects when full`; AC8                                 |
| X4  | queued → aborted (client) → removed, task never starts                                                       | `limiter.test.ts` › `abort queued`; AC10                                     |
| X5  | queued → deadline → `timeout(queued)`, removed                                                               | `limiter.test.ts` › `timeout queued`; AC9                                    |
| X6  | running → deadline/abort → caller rejected, slot held until task settles → next starts                       | `limiter.test.ts` › `abort running keeps slot`; AC9, AC10                    |
| X7  | timed-out route completes later → cache populated → later hit                                                | `server.test.ts` › `timeout populates cache`; AC9                            |
| X8  | repeated identical calls (no-op on upstream: cache hit)                                                      | AC6(a)                                                                       |
| X9  | cross-client same-key in-flight claim (RSS claim → MCP waits → hit)                                          | AC6(d)                                                                       |
| X10 | stale claim / `RequestInProgressError` surfacing → `request_in_progress`                                     | `dispatch.test.ts` › `in progress` (hold > waiter budget in test env, 3 s)   |
| X11 | allowlist resolution memoized; failed resolution retried on next call                                        | `allowlist.test.ts` › `retries after failure`                                |
| X12 | dev registry: first MCP call loads only allowlisted dirs; repeat is a no-op                                  | `registry-dev.test.ts` › `ensureNamespacesLoaded idempotent`                 |
| X13 | config: disabled → not loaded; enabled → mounted unauthenticated with a warning                              | AC1                                                                          |
| X14 | process restart: no persisted MCP state (stateless per request); cache entries survive per backend semantics | design note; AC3 (each request fresh server instance)                        |
| X15 | upstream rate limit → error, no automatic retry by MCP                                                       | `errors.test.ts`, `index.test.ts` › `errors` (upstream hit count 1 per call) |
| X16 | orphan guard: HEAD red → D17 repair green; other orphans still reported                                      | `scripts/workflow/check-orphan-files.test.ts`; AC16                          |

### Decisions

- **D1 — SDK.** Use `@modelcontextprotocol/server@2.4.0` as an exact-pinned dependency, and
  `@modelcontextprotocol/client@2.4.0` as an exact-pinned devDependency (tests/E2E only). Do not add
  `@modelcontextprotocol/hono` (its value is Host/Origin helpers for localhost binds; we gate ourselves) or the v1
  `@modelcontextprotocol/sdk` (extra express stack).
- **D2 — Transport.** Use `createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json', maxRequestBodySize:
  65536 })`.
    - Stateless: no session store, safe across restarts and replicas. Serves 2026-07-28 and 2025-era clients.
    - `json` response mode: tools emit no mid-call notifications, so single JSON bodies are simpler and avoid SSE
      through proxies.
    - The factory builds a fresh `McpServer` per request; limiter, allowlist and dispatcher are module-level singletons
      created once per mounted endpoint.
- **D3 — Mounting.** `app.all('/mcp', endpoint)` is registered in `lib/app-bootstrap.tsx` immediately after
  `app.use(trimTrailingSlash())` and before `compress()` and every other middleware, only when enabled. The module is
  loaded by dynamic `await import('@/mcp')`, so disabled servers never load the SDK. The exact path `/mcp` is fixed.
- **D4 — In-process dispatch.**
    - `fetch_feed` calls `app.fetch(new Request('http://localhost' + path), createInternalRequestEnv(state))`, which
      goes through the full existing middleware stack and router.
    - A module-private `Symbol` in `ctx.env` marks internal requests. It cannot come from HTTP: node-server env is
      `{incoming, outgoing}` and worker env holds bindings. Exactly three shared touchpoints read it:
        - `access-control.ts`: internal requests skip the key/code check. Per the user's no-auth decision (D6), MCP
          callers are not authenticated, and `ACCESS_KEY` deliberately does not gate allowlisted feeds reached through
          MCP;
        - `template.tsx`: internal requests return the raw normalized `result` JSON, like the existing `isPackage`
          branch;
        - `errors/index.tsx`: internal requests store the thrown error in the state object and return JSON
          `{error:{name,message}}`, after the existing counters, Sentry/Honeybadger, and logging.
    - No other existing behavior changes. Rejected alternatives:
        - `?format=json` JSON Feed: a different cache key from RSS readers, so it doubles source calls, and it loses
          error classes;
        - direct `route.handler()`: bypasses middleware and cache coordination;
        - a duplicate middleware stack: drifts from the existing one.
- **D5 — Shared cache key.** MCP dispatches the bare path, with no query. Its key equals a default RSS reader's, so
  MCP and Miniflux share cached snapshots and same-key claims. Item limiting is done by MCP after the pipeline, not
  via `?limit`.
- **D6 — No authentication (user decision, 2026-11-15).**
    - `/mcp` accepts requests without credentials. No `MCP_AUTH_TOKENS` setting exists.
    - `Authorization` headers and `key`/`code`/`token` query parameters are ignored; they are never compared and never
      logged. `ACCESS_KEY` does not apply to `/mcp`.
    - No `authInfo` is passed to the SDK.
    - `Origin` validation stays (MCP transport guidance against DNS rebinding): requests carrying `Origin` must exactly
      match an entry of `MCP_ALLOWED_ORIGINS` (default empty: no browser origins). Requests without `Origin` (typical
      agents) pass.
    - Startup logs one warn line (AC1) that the endpoint is unauthenticated.
    - DOC1/DOC3 state that exposure control is the operator's job (private network, VPN or authenticating reverse
      proxy, plus HTTPS), and that anyone reaching `/mcp` can read every allowlisted feed.
    - Rejected per the user's answer: required bearer tokens; optional tokens.
- **D7 — Allowlist.**
    - `MCP_ROUTES` holds comma-separated full route patterns exactly as registered (`/<namespace><route path>`).
    - The default is the read-only Twitter set:
      `/twitter/user/:id/:routeParams?`, `/twitter/keyword/:keyword/:routeParams?`, `/twitter/list/:id/:routeParams?`,
      `/twitter/media/:id/:routeParams?`, `/twitter/tweet/:id/status/:status/:original?`,
      `/twitter/home/:routeParams?`, `/twitter/home_latest/:routeParams?`, `/twitter/likes/:id/:routeParams?`.
    - Each pattern is resolved against the live `namespaces`: longest namespace key `N` with `P` starting with `/${N}/`,
      and a route key `P.slice(N.length + 1)` existing in `namespaces[N].routes`.
    - Dispatch admission reproduces RSSHub's own route choice: namespaces are deepest-first (as
      `sortNamespacesByDepth`), routes ordered by the exported `sortRoutes`, each namespace's routes are matched with
      Hono's default router (`SmartRouter{RegExpRouter, TrieRouter}`), and the **first** matching route must be
      allowlisted.
    - Resolution is memoized per endpoint and retried after a failure. In dev mode it first calls the new
      `ensureNamespacesLoaded(topDirs)`.
- **D8 — Limiter.**
    - Per process, FIFO. `MCP_MAX_CONCURRENCY` (default 1, min 1), `MCP_MAX_QUEUE` (default 4, min 0).
    - One deadline per call, `MCP_TIMEOUT` seconds (default 50, below the client's default 60 s request timeout),
      combining `ctx.mcpReq.signal`, the HTTP request signal (`requestInfo.signal`) and `AbortSignal.timeout`.
    - A running task's slot is released only when its dispatched route settles, because the pipeline cannot be aborted
      mid-route and this protects the source account. A route that never settles keeps its slot; this is documented,
      since upstream HTTP has its own `REQUEST_TIMEOUT` and retries.
    - `search_routes` bypasses the limiter (no source access).
    - Scope documented: the limiter does not serialize RSS HTTP traffic, other processes, cluster workers
      (`ENABLE_CLUSTER` → limits per worker) or replicas. Strict account serialization across RSS+MCP would require
      the Twitter request boundary, which is out of scope (D15).
- **D9 — Error taxonomy.**
    - Closed enum `McpErrorCode` (AC11). Classification is by `error.name` first, then HTTP status
      (`statusCode`/`status`/`response.status`), then two message rules: `/^this route is empty/` → `empty_result` and
      `/\berror:?\s*429\b/i` → `upstream_rate_limited` (the existing Twitter web API format, without changing it).
    - `retryable` is fixed per code: true for `upstream_rate_limited`, `upstream_error`, `request_in_progress`,
      `capacity_exceeded`, `timeout`; false otherwise.
    - `retryAfterSeconds` comes from a `Retry-After` header (delta-seconds or HTTP-date) on `error.response.headers`
      when present.
    - Messages are a fixed per-code sentence plus a redacted, ≤ 300-char detail; never a stack.
    - No automatic retries.
- **D10 — Output contract** (`fetch_feed` success `structuredContent`):

    ```ts
    {
      route: { path: string; namespace: string; name: string };
      requestPath: string;
      feed: { title: string; link?: string; description?: string; image?: string; language?: string; author?: string };
      items: Array<{
        title?: string; link?: string; guid?: string;
        pubDate?: string; updated?: string;            // ISO 8601, omitted if absent/invalid
        author?: string; categories?: string[];
        content?: string; contentFormat: 'text' | 'html' | 'none'; contentTruncated: boolean;
        image?: string; enclosure?: { url: string; type?: string; length?: number };
      }>;
      itemCount: number;            // items in the processed snapshot
      returnedCount: number;
      truncation: { items: boolean; content: boolean; bytes: boolean };
      snapshot: { cache: 'hit' | 'miss' | 'disabled'; builtAt: string; ttlMinutes: number; pagination: 'none' };
    }
    ```

    - `content` modes: `text` (default) = `htmlToText(item.description)` from `@/magpie/feed`; `html` = the
      pipeline-processed description HTML (can be cut mid-markup when clipped); `none` = omitted.
    - `guid` = `item.guid ?? item.link`.
    - `content[0]` = `{type:'text', text: JSON.stringify(structuredContent)}`, so a result is ≈ 2× the byte bound
      (documented).
    - Error results are `{ isError: true, structuredContent: { error: { code, message, retryable, retryAfterSeconds?,
      phase? } }, content: [{ type: 'text', text: <same JSON> }] }`.

- **D11 — Freshness.**
    - `snapshot.cache`: `hit` if response header `RSSHub-Cache-Status: HIT`; else `miss` if
      `cache.status.available`; else `disabled`.
    - `builtAt`: ISO of `result.lastBuildDate`, which on hit is the stored stamp, or MCP completion time when the cache
      is disabled. It is never described as upstream fetch time; route-internal `cache.tryGet` layers can make the data
      older, documented.
- **D12 — Twitter evidence scope.**
    - Deterministic Twitter evidence is limited to discovery (registry metadata) and the real missing-credential path
      (`source_config_missing`), with no network.
    - Success, cache and concurrency behavior are proven on fixture routes through the same pipeline.
    - Rejected: a `TWITTER_THIRD_PARTY_API` loopback fixture. Web API `init()` fetches x.com/jsdelivr (non-hermetic),
      and a GraphQL fixture would be a de-facto route test (repository rule 50).
    - A live authenticated pilot is a documented manual follow-up, not part of acceptance.
- **D13 — Runtimes.**
    - Enabled: the Node server entries (`lib/index.ts` dev/production, built `dist/index.mjs`, which the Nix package
      runs); the Vercel entry (`lib/server.ts`) mounts the same app (build-checked only).
    - Not exposed: the Cloudflare Worker (`app.worker.tsx` has its own app, and no MCP is mounted) and the container
      worker (a proxy to Node; MCP is served by the Node process inside when configured).
    - Package mode (`lib/pkg.ts`) is unaffected unless `MCP_ENABLE` is set.
    - All defaults: see [Config](#config).
- **D14 — Dev registry narrow loading.** Add `ensureLoaded(names: string[])` to `DevRegistry` and export
  `ensureNamespacesLoaded(names)` from `lib/registry.ts`, a no-op outside dev. Discovery never calls
  `ensureAllLoaded()`.
- **D15 — Untouched surfaces.** No changes to `lib/routes/**` (including Twitter transport, `getAuth` token locks and
  cooldowns), `lib/middleware/cache.ts`, `parameter.ts`, `header.ts`, `lib/magpie/**`, `flake.nix`, `devenv.nix`, or
  `scripts/e2e/run.mjs`.
- **D16 — Tests live outside `lib/routes`.** Rule 50 applies. Fixtures live under `scripts/e2e/fixtures/`; vitest
  integration tests reuse them via `USER_ROUTES_PATH`. Each new `lib/**/*.test.ts` sits next to a same-basename
  source, as the orphan guard requires: `limiter`, `errors`, `allowlist`, `result`, `catalog` units; `index`
  (endpoint integration: access/Origin, protocol, tools, errors, restriction, no secrets); `dispatch` (cache integration,
  AC6); `server` (concurrency, timeout and cancel integration, AC8–AC10).
- **D17 — Minimal orphan-guard repair** (prerequisite; repository tooling, not MCP product code).
    - In `scripts/workflow/check-orphan-files.ts`:
        - change the signature to `export const findOrphanFiles = async (root: string = repoRoot): Promise<string[]>`,
          using `root` wherever `repoRoot` is used today;
        - add `const allowedOutsideLib: ReadonlySet<string> = new Set(['test/twitter-client-transaction-id.test.ts'])`;
        - exclude exactly those relative paths from `deprecated`.
    - No other rule changes. `build-routes.ts` calls it unchanged with the default root.
    - Rejected alternatives:
        - exempting all of `test/**`: broader than needed, and re-admits stray files;
        - moving the test under `lib/routes/twitter/...`: forbidden by rule 50 and the guard;
        - moving it to another `lib/` path: fails the same-basename rule;
        - deleting or skipping it: loses existing coverage.
    - Regression test: `scripts/workflow/check-orphan-files.test.ts` (discovered by default vitest include, and outside
      the guard's scanned folders) proves AC16. Red on HEAD; green after the repair.

### Required documentation

- **DOC1** — `docs/mcp-endpoint.md`: purpose; enabling; every `MCP_*` variable with default and bounds; exact path;
  a prominent statement that the endpoint has **no authentication** (D6), that `ACCESS_KEY` does not protect it,
  and that the operator must restrict access (private network/VPN or an authenticating reverse proxy, plus HTTPS);
  Origin rules; runtimes (D13).
- **DOC2** — `docs/mcp-endpoint.md`: tool contracts (`search_routes`, `fetch_feed` input/output schemas), the error
  code table with retryability, truncation/byte bound, freshness semantics (D10, D11), no pagination.
- **DOC3** — `docs/mcp-endpoint.md`: limitations:
    - concurrency scope (D8);
    - cache coordination only on memory/Redis, and memory only within one process;
    - default Twitter allowlist, its credential requirements, and that it uses X's internal web API: not a supported
      third-party contract, X automation rules prohibit non-API automation, successful requests don't establish
      permission; the official API alternative is linked;
    - unauthenticated endpoint: anyone reaching `/mcp` can read every allowlisted feed, including the configured
      Twitter account's home timeline and likes;
    - read-only (no write actions);
    - no live Twitter verification performed;
    - feed content not redacted;
    - flake package `pnpmDeps` hash must be refreshed before a Nix deployment (lockfile changed).
- **DOC4** — `docs/mcp-endpoint.md`: verifying with a real MCP client. A curl `initialize` example and a
  `@modelcontextprotocol/client` snippet, plus a generic "add an HTTP MCP server at `https://<host>/mcp`"
  instruction (with a note that any proxy-level credentials are the operator's). No user agent configuration is
  performed by this work.
- **DOC5** — `AGENTS.md`:
    - a new "MCP endpoint E2E" subsection with the entrypoint, prerequisites (setup and `pnpm build` as separate heavy
      jobs), evidence location, what it does and does not verify, and a named block ` ```qex-e2e mcp ` with
      `{"resources":{"cpu":2,"mem":"4GiB"},"timeout":"15m"}`;
    - the statement: "The agent runs these E2E tests when a feature is first added; future pushes and deployments do
      not require rerunning them; existing unit tests must still be run."
    - Validated with `agent-job estimates --cwd <worktree>`.

### Verification criteria (exact acceptance wording)

- **V1 — Baseline comparison of existing units.**
    - Baseline inputs: base commit `5b2078027ed49763fb884401c6997c911652c7e7` plus **exactly** the guard-only delta
      of D17. The delta is `scripts/workflow/check-orphan-files.ts` (modified) and
      `scripts/workflow/check-orphan-files.test.ts` (added), with no other tracked or untracked changes.
    - Unchanged HEAD cannot run `build:routes` (finding 11), so a pure-HEAD baseline is impossible.
    - The delta is recorded before the baseline runs, in `$RUN_DIR/baseline-inputs.md`:
        - `git status --porcelain` (exactly those two paths);
        - `git diff -- scripts/workflow/check-orphan-files.ts | sha256sum`;
        - `sha256sum scripts/workflow/check-orphan-files.test.ts`;
        - the `sh $RUN_DIR/snap.sh .` tree id.
    - The baseline run (check `baseline-units`) uses those inputs, the same Nix shell, `pnpm build:routes` output,
      Redis helper, Chromium and the frozen install (pre-MCP lockfile). Every test case (junit `classname + name`) that **passed** there also **passes**
      in the final run (check `units-coverage`) on the feature branch. Every baseline failure or error is listed in
      `verification.md` with its baseline message and either passes or fails with the same message. Every test case
      added by this feature passes. No test case added by this feature is skipped, except the Redis-only cases when
      `REDIS_URL` is unset, which must not occur in `units-coverage`.
- **V2** — `format:check`, `eslint` on changed files, `typecheck`, `build`, `build:lib`, vercel build and
  `worker-build` all exit 0 on the final inputs.
    - `vitest:workerd` (check `units-workerd`) must also exit 0, **unless** the baseline checks `baseline-worker-build`
      and `baseline-workerd`, run on the V1 baseline inputs before any MCP change, recorded failures.
    - In that case the V1 rule applies to their junit: every baseline-passing workerd case passes, and every
      baseline-failing case is listed and either passes or fails with the same message.
    - If `baseline-worker-build` itself fails, the final `worker-build` must still exit 0 or fail with the identical
      error. The failure is recorded as pre-existing.
    - Without baseline workerd evidence, the exception is not available.
- **V3** — E2E `mcp` journey `result.json` has `passed: true` with every step S1–S16 and P1 `passed`, on final
  inputs, under a qex `--e2e mcp` admission. The existing `browser` smoke passes under qex `--e2e browser`.

## Design

### Module boundaries and files

New (all under T1):

| File                                          | Responsibility                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/utils/internal-request.ts`               | Unforgeable internal-dispatch marker (worker-safe, no Node APIs)                                                                                    |
| `lib/mcp/index.ts`                            | `createMcpEndpoint`: Hono handler, wiring of Origin gate → SDK handler; singletons                                                                  |
| `lib/mcp/origin.ts`                           | Origin gate (no authentication, D6)                                                                                                                 |
| `lib/mcp/limiter.ts`                          | Bounded FIFO admission with deadline/abort semantics                                                                                                |
| `lib/mcp/allowlist.ts`                        | Pattern resolution against registry, path validation, RSSHub-order route matching                                                                   |
| `lib/mcp/catalog.ts`                          | `search_routes` mapping/search/pagination (uses `@/magpie/catalog`)                                                                                 |
| `lib/mcp/dispatch.ts`                         | In-process feed dispatch and outcome extraction                                                                                                     |
| `lib/mcp/errors.ts`                           | `McpErrorCode`, classification, redaction, error results                                                                                            |
| `lib/mcp/result.ts`                           | `Data` → `fetch_feed` result mapping, truncation, byte bound, freshness                                                                             |
| `lib/mcp/server.ts`                           | `buildMcpServer`: tool registration, zod schemas                                                                                                    |
| `lib/mcp/test-harness.ts`                     | Test-only helper: start real app + node-server + fixture upstream (imported only by tests)                                                          |
| `lib/mcp/*.test.ts`                           | units `limiter`, `errors`, `allowlist`, `result`, `catalog`; integration `index`, `dispatch`, `server` (each next to its same-basename source, D16) |
| `scripts/workflow/check-orphan-files.test.ts` | D17/AC16 regression test                                                                                                                            |
| `scripts/e2e/fixture-upstream.mjs`            | Counting/holding loopback upstream used by vitest harness and E2E                                                                                   |
| `scripts/e2e/fixtures/e2e-mcp.mjs`            | User-route fixture namespace `e2e-mcp`                                                                                                              |
| `scripts/e2e/mcp.mjs`                         | MCP E2E journey runner                                                                                                                              |
| `docs/mcp-endpoint.md`                        | DOC1–DOC4                                                                                                                                           |

Modified: `package.json` (deps; script `test:e2e:mcp`), `pnpm-lock.yaml`, `lib/config.ts`, `lib/config.test.ts`,
`lib/app-bootstrap.tsx`, `lib/app-bootstrap.test.tsx`, `lib/middleware/access-control.ts` (+ test),
`lib/middleware/template.tsx` (+ test), `lib/errors/index.tsx` (+ test), `lib/registry.ts`, `lib/registry-dev.ts`,
`lib/registry-dev.test.ts`, `AGENTS.md`, `scripts/workflow/check-orphan-files.ts` (D17 only).

Consumed unchanged: `@/magpie/catalog` (`createCatalog`), `@/magpie/feed` (`htmlToText`), `@/registry-helpers`
(`sortRoutes`, types), `@/utils/cache` (`status.available`), `@/utils/logger`, Hono routers.

### Config

Added to `ConfigEnvKeys`, `Config` and `calculateValue()` in `lib/config.ts`. Parsing: comma lists are split, trimmed
and empty entries dropped. An integer that is `NaN` or below its minimum falls back to the default.

```ts
export const DEFAULT_MCP_ROUTES: readonly string[] = [/* the eight patterns of D7, in that order */];

mcp: {
    enable: boolean;            // MCP_ENABLE, toBoolean, default false
    routes: string[];           // MCP_ROUTES, default [...DEFAULT_MCP_ROUTES]
    maxConcurrency: number;     // MCP_MAX_CONCURRENCY, default 1, min 1
    maxQueue: number;           // MCP_MAX_QUEUE, default 4, min 0
    timeout: number;            // MCP_TIMEOUT seconds, default 50, min 1
    maxItems: number;           // MCP_MAX_ITEMS, default 20, min 1, max 100
    maxResponseBytes: number;   // MCP_MAX_RESPONSE_BYTES, default 262144, min 4096
    allowedOrigins: string[];   // MCP_ALLOWED_ORIGINS, default []
};
```

Constants: per-item content limit `MCP_ITEM_CONTENT_MAX_CHARS = 4000`; `search_routes` limit 1–50 (default 10);
description clip 500 chars; error detail clip 300 chars; request body limit 65536 bytes; path max 2048 chars.

### Interfaces (exact signatures)

```ts
// lib/utils/internal-request.ts
import type { Context } from 'hono';
const internalRequestKey: unique symbol = Symbol('rsshub.internal-request'); // not exported
export interface InternalRequestState {
    error?: unknown;
}
export type InternalRequestEnv = { readonly [internalRequestKey]: InternalRequestState };
export function createInternalRequestEnv(state: InternalRequestState): InternalRequestEnv;
export function getInternalRequestState(ctx: Context): InternalRequestState | undefined;
```

Shared middleware edits (the only behavior changes to existing modules):

```ts
// access-control.ts — first statement of the middleware
if (getInternalRequestState(ctx)) {
    await next();
    return;
}
// template.tsx — replace `if (config.isPackage) { return ctx.json(result); }`
if (config.isPackage || getInternalRequestState(ctx)) {
    return ctx.json(result);
}
// errors/index.tsx — after logger.error(...) and requestMetric.error(...), before the existing return
const internal = getInternalRequestState(ctx);
if (internal) {
    internal.error = error;
    return ctx.json({ error: { name: error.name, message: error.message } });
}
```

```ts
// lib/registry-dev.ts
export type DevRegistry = { middleware: MiddlewareHandler; ensureAllLoaded: () => Promise<void>; ensureLoaded: (names: string[]) => Promise<void> };
// ensureLoaded: for each name that is in topDirectories, await ensureTopDirectory(name); unknown names ignored.
// lib/registry.ts
export const ensureNamespacesLoaded: (names: string[]) => Promise<void>; // devRegistry?.ensureLoaded ?? (() => Promise.resolve())
```

```ts
// lib/mcp/index.ts
import type { Handler } from 'hono';

import type { Config } from '@/config';
import type { InternalRequestEnv } from '@/utils/internal-request';
export type AppFetch = (request: Request, env: InternalRequestEnv) => Response | Promise<Response>;
export interface McpEndpointOptions {
    fetch: AppFetch;
    mcpConfig?: Config['mcp'];
}
export function createMcpEndpoint(options: McpEndpointOptions): Handler;
```

Wiring in `lib/app-bootstrap.tsx` (top-level await is already used in this codebase):

```ts
app.use(trimTrailingSlash());
if (config.mcp.enable) {
    const { createMcpEndpoint } = await import('@/mcp');
    app.all('/mcp', createMcpEndpoint({ fetch: (request, env) => app.fetch(request, env) }));
    logger.warn('MCP endpoint mounted at /mcp without authentication; restrict access at the network or reverse proxy');
}
app.use(compress());
// ...existing stack unchanged
```

```ts
// lib/mcp/origin.ts
export function checkOrigin(request: Request, mcpConfig: Config['mcp']): Response | undefined;
// 403 JSON {"error":"forbidden_origin"} when an Origin header is present and not exactly in allowedOrigins; else undefined.
// Never reads the body, query or Authorization header.
```

```ts
// lib/mcp/limiter.ts
export class CapacityError extends Error {
    name: 'McpCapacityError';
}
export class LimiterAbortError extends Error {
    name: 'McpLimiterAbortError';
    readonly phase: 'queued' | 'running';
    readonly reason: unknown;
}
export interface LimiterStats {
    active: number;
    queued: number;
    maxConcurrency: number;
    maxQueue: number;
}
export interface Limiter {
    run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T>;
    stats(): LimiterStats;
}
export function createLimiter(options: { maxConcurrency: number; maxQueue: number }): Limiter;
```

Limiter contract:

- `run` rejects synchronously-at-call with `CapacityError` iff `active === maxConcurrency && queued === maxQueue`.
- An already-aborted signal rejects with `LimiterAbortError('queued')` without queueing.
- Abort while queued: the call is removed and rejects with `LimiterAbortError('queued')`; `task` is never invoked.
- Abort while running: the call rejects immediately with `LimiterAbortError('running')`; the slot stays counted in
  `active` until `task()` settles. Its eventual result or rejection is swallowed, with no unhandled rejection.
- On settle, the next queued entry starts (FIFO).

```ts
// lib/mcp/allowlist.ts
export interface AllowedRoute {
    pattern: string; // full pattern, e.g. '/twitter/user/:id/:routeParams?'
    namespace: string; // e.g. 'twitter'
    routePath: string; // key in namespaces[namespace].routes
    route: Route; // registry metadata (handler not required)
    namespaceInfo: Namespace;
}
export interface Allowlist {
    routes: AllowedRoute[]; // resolved, in MCP_ROUTES order
    unresolved: string[];
    match(path: string): AllowedRoute | undefined; // RSSHub-order first match must be allowlisted (D7)
}
export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };
export function validateFeedPath(path: string): PathCheck;
// syntax only: string, 1..2048 chars, starts with '/', no '?', '#', whitespace or '//';
// new URL(path, 'http://localhost').pathname === path (rejects dot segments, including %2e forms, after normalization).
// Reserved non-feed paths (/mcp, /api/*, /healthz, /, /metrics, /robots.txt) never resolve as allowlisted routes,
// so match() rejects them as route_not_allowed.
export function resolveAllowlist(patterns: readonly string[], namespaces: NamespacesType): Allowlist;
export function createAllowlistProvider(options: {
    patterns: readonly string[];
    loadNamespaces: () => Promise<NamespacesType>; // default: ensureNamespacesLoaded(topDirs) then `namespaces` from '@/registry'
}): () => Promise<Allowlist>; // memoized; rejected promise is not memoized
```

```ts
// lib/mcp/catalog.ts
export interface RouteSummary {
    path: string;
    namespace: string;
    namespaceName: string;
    name: string;
    example?: string;
    description?: string;
    parameters: Array<{ name: string; optional: boolean; description?: string; default?: string; options?: string[] }>;
    requiresConfig: Array<{ name: string; optional: boolean }>;
}
export interface SearchResult {
    routes: RouteSummary[];
    total: number;
    nextOffset?: number;
}
export function searchAllowedRoutes(allowlist: Allowlist, input: { query?: string; limit?: number; offset?: number }): SearchResult;
// non-empty query: createCatalog(subset namespaces built from allowlist).search(query, Infinity) order; empty: sorted by path.
```

```ts
// lib/mcp/dispatch.ts
export type DispatchOutcome =
    | { kind: 'data'; data: Record<string, unknown> & { item: unknown[] }; cacheHit: boolean; completedAt: Date }
    | { kind: 'error'; error: unknown; status: number }
    | { kind: 'unsupported'; status: number; reason: string };
export interface FeedDispatcher {
    dispatch(path: string): Promise<DispatchOutcome>;
}
export function createFeedDispatcher(fetch: AppFetch): FeedDispatcher;
// Builds Request('http://localhost' + path, { method: 'GET' }) with no headers; state = {}; env = createInternalRequestEnv(state).
// state.error set → 'error'; status !== 200 → 'unsupported'; body not JSON or no Array `item` → 'unsupported'.
// cacheHit = response.headers.get('RSSHub-Cache-Status') === 'HIT'. Never rejects (internal failures → 'error' with the thrown value).
```

```ts
// lib/mcp/errors.ts
export type McpErrorCode =
    | 'invalid_arguments'
    | 'route_not_allowed'
    | 'route_not_found'
    | 'invalid_parameter'
    | 'source_config_missing'
    | 'access_denied'
    | 'captcha_required'
    | 'upstream_rate_limited'
    | 'upstream_error'
    | 'request_in_progress'
    | 'empty_result'
    | 'unsupported_result'
    | 'capacity_exceeded'
    | 'timeout'
    | 'internal_error';
export interface McpToolError {
    code: McpErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    phase?: 'queued' | 'running';
}
export function classifyError(error: unknown): McpToolError;
export function toolError(error: McpToolError): CallToolResult; // isError + structuredContent {error} + text JSON
export function createRedactor(config: Config): (text: string) => string;
```

```ts
// lib/mcp/result.ts
export interface FeedResultOptions { limit: number; content: 'text' | 'html' | 'none'; maxResponseBytes: number; cacheAvailable: boolean }
export function buildFeedResult(route: AllowedRoute, requestPath: string, outcome: Extract<DispatchOutcome, { kind: 'data' }>, options: FeedResultOptions): FetchFeedOutput;
export const fetchFeedOutputSchema: z.ZodType<FetchFeedOutput>;   // exactly D10
export const searchRoutesOutputSchema: z.ZodType<SearchResult>;
```

```ts
// lib/mcp/server.ts
export interface ToolDeps {
    mcpConfig: Config['mcp'];
    allowlist: () => Promise<Allowlist>;
    limiter: Limiter;
    dispatcher: FeedDispatcher;
    redact: (text: string) => string;
    cacheAvailable: () => boolean;
    log: (line: string) => void;
}
export function buildMcpServer(deps: ToolDeps, request?: Request): McpServer;
```

Tool schemas (zod 4, `z.object`):

- `search_routes` input: `{ query?: string (max 200), limit?: int 1..50, offset?: int ≥ 0 }`; annotations
  `{ readOnlyHint: true, openWorldHint: false }`.
- `fetch_feed` input: `{ path: string (1..2048), limit?: int 1..mcpConfig.maxItems, content?: 'text'|'html'|'none' }`;
  annotations `{ readOnlyHint: true, openWorldHint: true }`.
- Both declare `outputSchema` (success shape). Errors use `isError` (SDK skips output validation for them).
- Descriptions state the allowlist, the snapshot/no-pagination semantics, and that `path` must come from
  `search_routes`.

### Data flow

1. `POST /mcp` → Hono route (before the feed middleware).
2. `checkOrigin()` returns 403 early, without touching the body.
3. `handler.fetch(c.req.raw)`, where `handler = createMcpHandler((ctx) => buildMcpServer(deps,
   ctx.requestInfo), options)`.
4. Tool `fetch_feed`:
    - `validateFeedPath`, then `allowlist().match`; on failure → `invalid_arguments` / `route_not_allowed`, with no
      dispatch.
    - `signal = AbortSignal.any([ctx.mcpReq.signal, request.signal, AbortSignal.timeout(timeout*1000)])`.
    - `limiter.run(() => dispatcher.dispatch(path), signal)`.
    - `dispatch` → `app.fetch(internalRequest, internalEnv)` → existing stack: logger, trace, Sentry, access-control
      (internal skip), debug, template, header, antiHotlink, parameter, cache (claim/hit/store), registry or dev
      sub-app, route handler.
    - template returns raw `result` JSON; errorHandler captures the error into the state.
    - outcome → `buildFeedResult` or `classifyError` → redaction → tool result.
5. One log line per tool call: `mcp <tool> <pattern|-> <ok|code> <ms>ms`. The 403 log is `mcp: rejected origin`, with no
   header values.
6. Errors thrown inside the Hono handler (outside the SDK) → `500` JSON-RPC `{"jsonrpc":"2.0","error":{"code":-32603,
   "message":"Internal error"},"id":null}`.

Timeout mapping: the deadline signal fired → `timeout` with the `LimiterAbortError.phase`. A client abort is rethrown
(the SDK/HTTP layer has no recipient). `CapacityError` → `capacity_exceeded`.

### Conventions

- TypeScript ESM with `@/` aliases and camelCase; imports sorted (oxfmt `sortImports`); arrow-function params
  parenthesized; English comments.
- No `await` in loops where `Promise.all` applies; no explicit `null` properties; module-level functions.
- No new runtime dependencies beyond D1. Exact versions in `package.json` (repository style).
- Logging via `@/utils/logger`. No secrets in logs.
- Tests use vitest with `vi.resetModules()`, set `process.env` before `await import('@/app')`, and clean up servers
  and env in `afterAll`/`afterEach`. Tests avoid fixed sleeps for ordering and use upstream hold/release plus
  observed events. Timeouts in tests use small `MCP_TIMEOUT` (≥ 1 s) and stay within vitest `testTimeout` overrides
  set per test.

## Tasks

Single task, implemented in one shot; no split (no separate producer, no parallel gain, fits one worker).
Consolidated feature review after implementation. No early focused review is required: the consequential uncertainty
(SDK/transport/abort interop) is retired by T1's capability check before substantial implementation.

- **T1 — MCP endpoint: complete feature, wiring, tests, E2E harness, docs.** Wave 1, no dependencies.
    - Goal: everything in AC1–AC16, D1–D17, DOC1–DOC5, including the prerequisite guard repair and the baseline
      checkpoint. One worker keeps ownership of repair, baseline and implementation (no split: the guard repair is
      tiny and a prerequisite of T1's own checks, not a separate producer).
    - Owned files: every file in [Module boundaries and files](#module-boundaries-and-files) ("New" and "Modified"),
      i.e.:
        - `package.json`, `pnpm-lock.yaml`;
        - `lib/config.ts`, `lib/config.test.ts`;
        - `lib/app-bootstrap.tsx`, `lib/app-bootstrap.test.tsx`;
        - `lib/utils/internal-request.ts`;
        - `lib/middleware/access-control.ts`, `lib/middleware/access-control.test.ts`;
        - `lib/middleware/template.tsx`, `lib/middleware/template.test.ts`;
        - `lib/errors/index.tsx`, `lib/errors/index.test.ts`;
        - `lib/registry.ts`, `lib/registry-dev.ts`, `lib/registry-dev.test.ts`;
        - `lib/mcp/**`;
        - `scripts/e2e/fixture-upstream.mjs`, `scripts/e2e/fixtures/e2e-mcp.mjs`, `scripts/e2e/mcp.mjs`;
        - `docs/mcp-endpoint.md`, `AGENTS.md` (MCP E2E subsection and `qex-e2e mcp` block only);
        - `scripts/workflow/check-orphan-files.ts`, `scripts/workflow/check-orphan-files.test.ts` (D17 only).
    - Protected (must not edit): see D15; `scripts/e2e/run.mjs`, `scripts/e2e/server.ts`,
      `scripts/e2e/fixtures/e2e-smoke.mjs`, the existing `qex-e2e browser` block, `.github/**`, `flake.*`,
      `devenv.nix`, `docs/features/mcp-endpoint-plan.md`.
    - Interfaces consumed: `@/magpie/catalog.createCatalog`, `@/magpie/feed.htmlToText`,
      `@/registry-helpers.sortRoutes`, `@/registry.namespaces`, Hono `SmartRouter`/`RegExpRouter`/`TrieRouter`,
      `@modelcontextprotocol/server@2.4.0` (`createMcpHandler`, `McpServer`), `@modelcontextprotocol/client@2.4.0`
      (`Client`, `StreamableHTTPClientTransport`), `@hono/node-server` (`serve`).
    - Interfaces produced: all signatures in [Interfaces](#interfaces-exact-signatures); env contract in
      [Config](#config); tool schemas D10; E2E runner CLI `node scripts/e2e/mcp.mjs [--skip-production]` (default
      requires `dist/index.mjs`; `--skip-production` marks P1 `unrun` and the run as not passed).
    - Order inside T1 (one worker). Phase A must finish, with the baseline recorded, before any MCP product file is
      edited.
        - **Phase A — guard repair and baseline checkpoint:**
            1. Write `scripts/workflow/check-orphan-files.test.ts`. Run it on unchanged HEAD and record red (real-root result
               `['test/twitter-client-transaction-id.test.ts']`; the temporary-root cases need the `root` parameter, so
               they fail to call it).
            2. Apply D17. Run the test green.
            3. Confirm `git status --porcelain` shows only the two D17 paths and write `$RUN_DIR/baseline-inputs.md`
               (V1).
            4. Run checks `gen-routes`, `baseline-units`, `baseline-worker-build`, `baseline-workerd` with the exact
               commands in the inventory. Save junit and logs to `$RUN_DIR`. The baseline inputs must stay unchanged for
               the whole of Phase A: no other edits, no `pnpm add`.
            5. Re-check `sh $RUN_DIR/snap.sh .` equals the recorded tree id after the runs; otherwise rerun.
            6. Report the Phase A checkpoint in the worker report (junit paths, pass/fail counts, baseline failures with
               messages).
        - **Phase B — capability** (below), including adding dependencies and the `qex-e2e mcp` declaration.
        - **Phase C:** acceptance tests red on baseline for each AC, recorded.
        - **Phase D:** implementation.
        - **Phase E:** green, then journey proof.
    - Unit test command (task gate; from the worktree, after `build:routes`; Redis via the helper so AC6 Redis cases
      run):

        ```sh
        flock --close "$(git rev-parse --absolute-git-dir)/e2e-feature-build.lock" agent-job run heavy -- \
          nix develop --impure -c "$RUN_DIR/with-redis.sh" pnpm exec cross-env NODE_ENV=test vitest run --maxWorkers=4 \
          lib/mcp lib/config.test.ts lib/app-bootstrap.test.tsx lib/middleware/access-control.test.ts \
          lib/middleware/template.test.ts lib/errors/index.test.ts lib/registry-dev.test.ts lib/registry.test.ts \
          scripts/workflow/check-orphan-files.test.ts test/twitter-client-transaction-id.test.ts
        ```

        `$RUN_DIR = /home/sinkerine/dev/RSSHub/.git/worktrees/quiet-pelican/e2e-feature/mcp-endpoint`. The helper is
        orchestrator-owned; see [Environment recipe](#environment-recipe).

    - File/build conflicts: none with other tasks. Internal conflicts: `pnpm add` rewrites `package.json`,
      `pnpm-lock.yaml` and the scratch `node_modules`; `build:routes` rewrites `assets/build/*`; vitest coverage
      writes `coverage/`. All are serialized under the worktree build lock. No repository-wide formatter: run
      `pnpm exec oxfmt <owned files>` and `pnpm exec oxlint --type-aware --fix <owned files>` only.
    - External dependencies: npm registry access for `pnpm add` (setup only). Everything else is local.

Capability before substantial implementation: T1 Phase B; see Test and verification › Capability checks.

Before launching T1, the orchestrator has already run `setup` (passed) and provides the run-local helpers
`$RUN_DIR/with-redis.sh`, `$RUN_DIR/snap.sh` and `$RUN_DIR/compare-junit.mjs`. T1 owns the D17 repair and Phase A
baseline checkpoint. The orchestrator inspects the Phase A evidence and identities as part of T1's gate. The plan
file is protected; only the design agent edits it.

## Test and verification

### Environment recipe

- Host: kazuki. Every command runs from the worktree root `W=/home/sinkerine/.paseo/worktrees/150zojav/quiet-pelican`
  inside the pinned shell `nix develop --impure -c …`; agents have no direnv. There is no `.env` in the worktree, so
  test commands get no personal settings.
- **Setup** (heavy, separate job, before anything else; rerun after T1 changes the lockfile):
  `agent-job run heavy -- nix develop --impure -c bash scripts/dev-setup.sh`. This is a frozen install into
  `~/.cache/dev-scratch/rsshub/<sha256(W)[0:16]>/{pnpm-store,node_modules}` with normal checkout links.
- **Dependency addition** (T1 only, heavy, network): add the exact versions using the same store/virtual-store paths
  as `dev-setup.sh`:

    ```sh
    flock --close "$(git rev-parse --absolute-git-dir)/e2e-feature-build.lock" agent-job run heavy -- nix develop --impure -c bash -c '
      set -euo pipefail; key=$(printf %s "$PWD" | sha256sum | cut -c1-16); s="${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/rsshub/$key"
      export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
      pnpm add --save-exact --store-dir "$s/pnpm-store" --virtual-store-dir "$s/node_modules" @modelcontextprotocol/server@2.4.0
      pnpm add --save-exact --save-dev --store-dir "$s/pnpm-store" --virtual-store-dir "$s/node_modules" @modelcontextprotocol/client@2.4.0'
    ```

    Afterwards `pnpm install --frozen-lockfile` (setup) must succeed unchanged. If pnpm 12 rejects these flags, use
    the equivalent supported options and record a ruling.

- **Generated inputs:** `pnpm run build:routes` writes `assets/build/{routes.json,routes.js,route-paths.ts,
  radar-rules.json,radar-rules.js,maintainers.json}`. It is required before vitest, typecheck and builds, and must be
  rerun when `lib/routes/**`, `lib/registry*.ts` or the build script inputs change. `worker-build` additionally writes
  `assets/build/routes-worker.js` and `dist-worker/`.
- **Redis helper** (orchestrator-owned, run-local, `$RUN_DIR/with-redis.sh <cmd…>`):
    - obtain `redis-server` through `nix build --no-link --print-out-paths --inputs-from "$W" nixpkgs#redis` (the
      flake-locked nixpkgs);
    - pick a free loopback port with Node;
    - start `redis-server --bind 127.0.0.1 --port $p --save '' --appendonly no --dir <scratch>/verify/redis-<id>`
      under `~/.cache/dev-scratch/rsshub/<key>/verify/`;
    - wait for `PING`, export `REDIS_URL=redis://127.0.0.1:$p/`, run the command, then `SHUTDOWN NOSAVE` and remove
      its own scratch dir, preserving the exit status.

    It matches CI's Redis service. Promotion candidate for repo tooling (record at delivery, do not add now).

- **Chromium:** `CHROMIUM_EXECUTABLE_PATH` from the shell is used by the existing playwright unit tests and the
  browser smoke. The MCP E2E server env deliberately omits it.
- **Ports/state:** all servers bind `127.0.0.1:0`. E2E scratch:
  `~/.cache/dev-scratch/rsshub/<key>/e2e/mcp-run-*` (removed by the runner). Evidence:
  `assets/build/e2e/mcp-run-*/` (retained).
- **Resource groups / concurrency:** all checks share worktree outputs (`assets/build`, `coverage`, `dist*`,
  `node_modules`) and use the default exclusive legacy build lock. Recipe `max_parallel: 1`. E2E checks read `dist/`
  and must not overlap with `build-node`. Concurrency limit on this host for this run: 1.
- **qex:** heavy/medium/small profiles as listed per check. The E2E leaf uses `agent-job run --e2e mcp|browser`.
  Never nest: inside an admitted job (`AGENT_JOB_ACTIVE=1`) the descendants run directly. Validate
  `agent-job estimates --cwd "$W"` shows both `browser` and `mcp` before any MCP E2E execution.

### Check inventory (exact commands)

All commands are prefixed with `agent-job run <profile> -- nix develop --impure -c` unless the row says otherwise,
and run from `W`. Rows marked "rewrites" mutate worktree files.

| id                      | phase                                        | profile             | command                                                                                                                                                                                                                         | notes                                                                                                                       |
| ----------------------- | -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `setup`                 | pre                                          | heavy               | `bash scripts/dev-setup.sh`                                                                                                                                                                                                     | rewrites scratch `node_modules` (frozen)                                                                                    |
| `gen-routes`            | pre/full                                     | medium              | `pnpm run build:routes`                                                                                                                                                                                                         | rewrites `assets/build/*`; needed by all below                                                                              |
| `baseline-units`        | baseline (T1 Phase A: HEAD + D17 delta only) | heavy               | `$RUN_DIR/with-redis.sh pnpm exec cross-env NODE_ENV=test vitest run --coverage.enabled --maxWorkers=4 --reporter=default --reporter=junit --outputFile.junit=$RUN_DIR/junit-baseline.xml`                                      | same discovery/config as `vitest:coverage`; rewrites `coverage/`                                                            |
| `smoke`                 | smoke (≤ 60 s)                               | none (direct)       | `nix develop --impure -c bash -c 'node --version; pnpm --version; test -f assets/build/routes.json; pnpm ls --depth 0 hono zod @modelcontextprotocol/server @modelcontextprotocol/client'` and `agent-job estimates --cwd "$W"` | the MCP packages are expected absent before T1 adds them                                                                    |
| `T1`                    | task                                         | heavy               | T1 unit command above                                                                                                                                                                                                           | gate                                                                                                                        |
| `format`                | full                                         | medium              | `pnpm run format:check`                                                                                                                                                                                                         | oxlint type-aware + oxfmt check; run before builds                                                                          |
| `eslint`                | full                                         | medium              | `pnpm exec eslint --concurrency 2 <all changed/added .ts/.tsx/.mjs files>`                                                                                                                                                      | mirrors pre-commit hook scope                                                                                               |
| `typecheck`             | full                                         | medium              | `pnpm typecheck`                                                                                                                                                                                                                | consumer check for all `lib/**`                                                                                             |
| `units-coverage`        | full                                         | heavy               | same as `baseline-units` with `--outputFile.junit=$RUN_DIR/junit-feature.xml`                                                                                                                                                   | proves V1 together with `compare-junit`; proves all-required-units + coverage                                               |
| `compare-junit`         | full                                         | none (direct)       | `node $RUN_DIR/compare-junit.mjs $RUN_DIR/junit-baseline.xml $RUN_DIR/junit-feature.xml`                                                                                                                                        | orchestrator-owned; implements V1 exactly; also asserts AC6 Redis cases present and executed                                |
| `build-node`            | full                                         | heavy               | `pnpm run build`                                                                                                                                                                                                                | consumer: Node server (`dist/index.mjs`, run by Nix package); rewrites `dist/`, `assets/build`                              |
| `build-lib`             | full                                         | heavy               | `pnpm run build:lib`                                                                                                                                                                                                            | consumer: `pkg` + magpie plugin (dts); rewrites `dist-lib/`                                                                 |
| `build-vercel`          | full                                         | medium              | `pnpm exec tsdown --config ./tsdown-vercel.config.ts --out-dir "$HOME/.cache/dev-scratch/rsshub/<key>/verify/vercel-src"`                                                                                                       | consumer: `lib/server.ts`; scratch out-dir because `src/` is not git-ignored                                                |
| `worker-build`          | full                                         | heavy               | `pnpm run worker-build`                                                                                                                                                                                                         | consumer of changed middleware/errors/config via `app.worker.tsx`; rewrites `dist-worker/`, `assets/build/routes-worker.js` |
| `baseline-worker-build` | baseline (T1 Phase A)                        | heavy               | `pnpm run worker-build`                                                                                                                                                                                                         | V2 baseline; log to `$RUN_DIR/baseline-worker-build.log`; rewrites `dist-worker/`, `assets/build/routes-worker.js`          |
| `baseline-workerd`      | baseline (T1 Phase A)                        | heavy               | `pnpm exec cross-env NODE_ENV=test vitest run --config vitest.workers.config.ts --reporter=default --reporter=junit --outputFile.junit=$RUN_DIR/junit-workerd-baseline.xml`                                                     | same as `vitest:workerd` plus junit; needs `baseline-worker-build`                                                          |
| `units-workerd`         | full                                         | heavy               | `pnpm exec cross-env NODE_ENV=test vitest run --config vitest.workers.config.ts --reporter=default --reporter=junit --outputFile.junit=$RUN_DIR/junit-workerd-feature.xml`                                                      | worker runtime tests (CI parity, = `vitest:workerd` + junit); needs `worker-build`; compared to baseline per V2             |
| `e2e-mcp`               | e2e                                          | qex `--e2e mcp`     | `agent-job run --e2e mcp -- nix develop --impure -c node scripts/e2e/mcp.mjs`                                                                                                                                                   | needs `build-node` (`dist/`) and `setup`; V3                                                                                |
| `e2e-browser-smoke`     | e2e                                          | qex `--e2e browser` | `agent-job run --e2e browser -- nix develop --impure -c node scripts/e2e/run.mjs`                                                                                                                                               | AC13(d) regression                                                                                                          |

Recipe ordering (`needs`):

- baseline (T1 Phase A, on the V1 baseline inputs): `setup → gen-routes → baseline-units → baseline-worker-build →
  baseline-workerd`;
- `setup → gen-routes → {format, eslint, typecheck} → units-coverage → compare-junit`;
- `gen-routes → build-node → build-lib → build-vercel → worker-build → units-workerd`;
- `build-node → e2e-mcp → e2e-browser-smoke`.

Everything is serialized (`max_parallel: 1`). For async long runs use
`subagent({workflow:"e2e-verify", …, args:{feature:"mcp-endpoint", recipe:"$RUN_DIR/verification.json",
phase:"full"}})`. `environment_inputs` must include `flake.lock`, `pnpm-lock.yaml`, `assets/build/routes.json`,
`assets/build/route-paths.ts`, `dist/index.mjs` (E2E), the installed `agent-job`/qex identities and `AGENTS.md`.

Runner and test-project discovery:

- vitest `vitest.config.ts`: default include, setup `lib/setup.test.ts`, exclude `**/*.worker.test.ts`; coverage
  over `lib/**`, excluding `lib/routes/**`. New tests are under `lib/mcp/` and the existing `*.test.ts` files listed.
- `vitest.workers.config.ts` runs `*.worker.test.ts` under workerd.
- `test/twitter-client-transaction-id.test.ts` (root `test/`) is included by default discovery and stays in scope.
- No visual or Storybook projects exist.

Consumer check (every consumer of a changed interface):

| Changed interface                            | Consumers                                                             | Checks                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `config.ts` keys                             | all `lib/**`, worker                                                  | `typecheck`, `units-coverage`, `worker-build`, `units-workerd`                                                    |
| `access-control`, `template`, `errors/index` | `app-bootstrap` (Node, Vercel, pkg), `app.worker.tsx`                 | `units-coverage`, `build-node`, `build-vercel`, `build-lib`, `worker-build`, `units-workerd`, `e2e-browser-smoke` |
| `registry.ts`/`registry-dev.ts`              | `api/namespace/*`, `pkg.ts`, MCP                                      | `typecheck`, `units-coverage`, `e2e-mcp` (dev)                                                                    |
| `app-bootstrap` wiring                       | `lib/index.ts`, `lib/server.ts`, `lib/pkg.ts`, `lib/magpie/server.ts` | `build-node`, `build-vercel`, `build-lib`, `e2e-mcp` (dev + production)                                           |
| `package.json`/lock                          | Nix shell install, CI                                                 | `setup` (frozen) after T1                                                                                         |

Real counterparts: tests use the real RSSHub app, middleware, registries (`routes.json`, generated `routes.js`, dev
registry on `lib/routes`), the real SDK server and client, `@hono/node-server`, the real memory/Redis cache, and real
`ofetch` (against an msw 429 for the classifier). The only stand-in is the upstream source: a loopback HTTP fixture
replacing third-party websites. Live upstreams are unavailable, non-deterministic and not authorized (D12).

### Capability checks (before substantial implementation)

Stage 1 (design, done by the orchestrator): host check recorded in
`$RUN_DIR/verification.md`. Memory and disk were adequate; node/nix/direnv present; pnpm/Chromium only inside the
shell; no `node_modules`; the `browser` estimate is valid. MCP observation is unproven.

Stage 2 (orchestrator, then T1 first steps; one materially different target: local Node server on kazuki):

1. Orchestrator: `setup` (done, passed). T1 Phase A: D17 guard repair red/green, then `gen-routes` →
   `baseline-units` → `baseline-worker-build` → `baseline-workerd` on the recorded V1 baseline inputs. This records
   baseline junit and the exact pre-existing failures. It distinguishes environment inability from baseline test
   failures: Redis helper start, Chromium, workerd binary, network-dependent cases.
2. T1: add dependencies (command above). Add the `qex-e2e mcp` block to `AGENTS.md` and validate it with
   `agent-job estimates`.
3. T1: **SDK/transport interop probe**, the hardest real observation. Run a run-local script
   `$RUN_DIR/probe-mcp.mjs` (not product code) under `agent-job run --e2e mcp -- nix develop --impure -c node
   $RUN_DIR/probe-mcp.mjs`:
    - it serves `createMcpHandler` from `@modelcontextprotocol/server@2.4.0` through `@hono/node-server` on
      `127.0.0.1:0`, with one tool that waits on `ctx.mcpReq.signal`/`requestInfo.signal`;
    - it connects the real `@modelcontextprotocol/client@2.4.0` in legacy mode and in `{pin:'2026-07-28'}`, runs
      `tools/list` and `tools/call`;
    - it sends a raw legacy `tools/call` POST and aborts it with `AbortController`.

    Required observations, recorded with exact output in `$RUN_DIR/capability.md`:
    - both eras connect and list tools;
    - an `isError` result reaches the client with `structuredContent`;
    - the server-side signal fires within 1 s of the client abort;
    - `GET` → 405.

4. T1: **baseline journey harness check.** Write `scripts/e2e/fixture-upstream.mjs`,
   `scripts/e2e/fixtures/e2e-mcp.mjs` and `scripts/e2e/mcp.mjs` first, then run `e2e-mcp` with `--skip-production`
   on the unchanged product code.
    - Expected baseline result: S1 passes (server, fixture route, upstream counting, RSS/JSON and evidence capture
      work); S2 fails with `POST /mcp → 404, expected 200 initialize`. This is an expected feature failure.
    - Environment inability, distinct and blocking: server never ready, fixture not loaded, client import error, qex
      rejection, port bind failure.
    - Record both in `$RUN_DIR/capability.md`.
5. Then write the AC acceptance tests, record red on baseline (expected failures: `/mcp` 404, missing modules), and
   implement.

If step 3 shows the request signal is not delivered to tool handlers, use the documented fallback: abort via
`c.env.outgoing.on('close')` in the Hono handler → the combined signal. Record a ruling. AC10 is unchanged.

### Baseline vs feature failure expectations

- Expected feature-red on baseline: every new `lib/mcp/*.test.ts` (modules absent), the new `app-bootstrap`,
  `config`, `registry-dev`, `access-control`, `template` and `errors` cases (internal marker absent), and E2E S2–S16
  and P1.
- Not feature-red (must pass on baseline, or else they indicate an environment or pre-existing issue): all existing
  test cases, E2E S1, and the browser smoke.
- Prerequisite-red on unchanged HEAD (not a feature failure): `build:routes` orphan error (finding 11) and the new
  `check-orphan-files.test.ts`. Both go green with D17 alone, before the baseline runs.

### Repair ownership

T1's worker owns diagnosis, repair and the rerun for all owned files, including the E2E harness. The orchestrator
owns `$RUN_DIR` helpers (`with-redis.sh`, `compare-junit.mjs`, `probe-mcp.mjs`) and the recipe. Protected boundaries
are D15 and the Tasks "Protected" list. Commits happen only at the orchestrator's safe points. Pre-commit hooks may
rewrite staged files; revalidate affected receipts afterwards.

## E2E journey

Runner `scripts/e2e/mcp.mjs`, modeled on `scripts/e2e/run.mjs`. Execution: `agent-job run --e2e mcp -- nix develop
--impure -c node scripts/e2e/mcp.mjs` (async: `agent-job submit --e2e mcp -- nix develop --impure -c node
scripts/e2e/mcp.mjs`). Prerequisites, as separate jobs: `setup`, `build-node`.

Setup:

- scratch `~/.cache/dev-scratch/rsshub/<key>/e2e/mcp-run-*`, evidence `assets/build/e2e/mcp-run-*/`;
- random 32-byte hex `ACCESS_KEY` and `DUMMY_AUTH` (a value sent only as an ignored `Authorization` header in S2,
  used to prove headers are not logged);
- start the fixture upstream (`fixture-upstream.mjs`) on `127.0.0.1:0`;
- copy `fixtures/e2e-mcp.mjs` to `scratch/routes`;
- fork `scripts/e2e/server.ts` (tsx) with only `PATH, HOME, TMPDIR, TZ, SSL_CERT_FILE, NIX_SSL_CERT_FILE` from the
  host (no `CHROMIUM_EXECUTABLE_PATH`, no personal env), plus:
    - `NODE_ENV=dev PORT=0 LISTEN_INADDR_ANY=false ENABLE_CLUSTER=false CACHE_TYPE=memory NO_LOGFILES=true`
    - `DOTENV_CONFIG_PATH=<scratch>/absent.env USER_ROUTES_PATH=<scratch>/routes E2E_MCP_UPSTREAM=<upstream url>`
    - `ACCESS_KEY=<key> MCP_ENABLE=true MCP_MAX_CONCURRENCY=1 MCP_MAX_QUEUE=1`
    - `MCP_TIMEOUT=8 MCP_MAX_ITEMS=10 MCP_MAX_RESPONSE_BYTES=16384`
    - `MCP_ROUTES=<the 8 default Twitter patterns>,/e2e-mcp/feed/:id,/e2e-mcp/hold/:id,/e2e-mcp/fail/:kind,/e2e-mcp/empty,/e2e-mcp/empty-ok,/e2e-mcp/raw`

Fixture contract:

- `fixture-upstream.mjs` exports `startFixtureUpstream(): Promise<{ url, hits(path?): number, log(): Array<{path,
  at}>, hold(id), release(id), close() }>`.
- `/feed/:id` returns JSON items: 30 items with ~6000-char HTML for `big`, otherwise 3 items. Fixed descending
  dates; links `https://example.com/<id>/<n>`.
- `/hold/:id` responds only after `release(id)`.
- `e2e-mcp.mjs` routes:
    - `/feed/:id` and `/hold/:id` fetch the upstream and map it to `Data`;
    - `/fail/:kind` throws locally, by kind:
        - `rate-limit`: a `FetchError`-shaped error, `statusCode: 429`, `response` with `Retry-After: 120`, message
          containing a `?token=` URL;
        - `twitter-429`: `Error('Twitter API error: 429')`;
        - `upstream`: `Error('Twitter API error: 500')`;
        - `config`: an error with `name: 'ConfigNotFoundError'`;
        - `secret`: a message embedding `process.env.ACCESS_KEY` and an `?api_key=` URL;
    - `/empty` returns zero items without `allowEmpty`; `/empty-ok` returns zero items with `allowEmpty: true`;
      `/raw` returns `new Response('raw')`.

The client is `@modelcontextprotocol/client@2.4.0` `Client` + `StreamableHTTPClientTransport`, with no credentials and a
`fetch` wrapper that records every request (method, URL, presence of `Origin`/`Authorization`, never their values)
and every raw response body to `transcript.jsonl`.

Steps (each records expected, actual, `passed` and evidence paths in `result.json`):

- **S1 Baseline feeds.**
    - `GET /healthz` → 200 `ok`.
    - `GET /e2e-mcp/feed/rss-a` (no key) → 403.
    - `?key=<ACCESS_KEY>` → 200, `content-type` xml, `<rss`, 3 items. `?format=json&key=…` → JSON Feed with 3 items.
    - Upstream `rss-a` hits = 2 (RSS and JSON keys differ). Saved: `feed-before.xml`.
- **S2 Access (no auth).** `server.log` contains the warn line `MCP endpoint mounted at /mcp without
  authentication`. Each `POST /mcp` legacy `initialize` gets the stated response; `GET /mcp` and `DELETE /mcp` → 405.
    - no `Authorization`, no key (while `ACCESS_KEY` is set) → 200 initialize result;
    - `Authorization: Bearer <DUMMY_AUTH>` → 200 (ignored);
    - `?key=wrong` → 200 (ignored);
    - `Origin: https://evil.example` → 403 `forbidden_origin`.

    After the 403 the upstream hit total is unchanged and `server.log` has no `mcp fetch_feed`/`mcp search_routes`
    line for it.

- **S3 Legacy client.** `connect()` (initialize) succeeds; `getServerVersion().name === 'rsshub'`; negotiated
  protocol is a 2025 revision; `listTools()` → exactly `fetch_feed`, `search_routes`, each with input/output schema
  and `readOnlyHint`.
- **S4 Modern client.** A second client with `versionNegotiation: { mode: { pin: '2026-07-28' } }` connects
  successfully, and its `listTools()` returns the same two names.
- **S5 Discovery.**
    - `search_routes {query:'twitter'}` → `total === 8` and the exact set of D7 patterns. Each has `name`; `/user`
      lists parameters `id` (required) and `routeParams` (optional); `requiresConfig` names include
      `TWITTER_AUTH_TOKEN` and no value fields. Trends and spaces patterns are absent.
    - `{}` → `total === 14`, sorted by path.
    - `{limit:3}` → 3 routes, `nextOffset === 3`.
    - Narrow dev loading itself (only allowlisted directories, never `ensureAllLoaded`) is proven by
      `lib/registry-dev.test.ts`, not by this step.
- **S6 Success, bounds, cache.**
    - Legacy `fetch_feed {path:'/e2e-mcp/feed/big', limit:5}` → `returnedCount 5`, `itemCount 30`,
      `truncation.items true`, `truncation.content true`, every `content.length ≤ 4000`, `contentFormat 'text'`, ISO
      `pubDate`s descending, absolute links, `snapshot.cache 'miss'`, `pagination 'none'`. Upstream `big` hits = 1.
    - Modern client, same call → `cache 'hit'`, the same `builtAt`, `big` hits still 1.
    - `GET /e2e-mcp/feed/big?key=…` → 200 with `RSSHub-Cache-Status: HIT`, `big` hits still 1.
    - `fetch_feed {path:'/e2e-mcp/feed/rss-a'}` → `cache 'hit'` (warmed by RSS in S1), `rss-a` hits still 2.
- **S7 Byte bound.** `fetch_feed {path:'/e2e-mcp/feed/big', limit:10, content:'html'}`:
    - UTF-8 length of `JSON.stringify(structuredContent)` ≤ 16384;
    - `truncation.bytes true`, `returnedCount < 10`;
    - `content[0].text` parses to the same object.
- **S8 Empty.** `/e2e-mcp/empty` → `isError`, `code 'empty_result'`. `/e2e-mcp/empty-ok` → success with
  `items: []` and `itemCount 0`.
- **S9 Errors.** Each call yields the stated result:
    - `/e2e-mcp/fail/rate-limit` → `upstream_rate_limited`, `retryAfterSeconds 120`, `retryable true`;
    - `/fail/twitter-429` → `upstream_rate_limited`, no `retryAfterSeconds`;
    - `/fail/upstream` → `upstream_error`;
    - `/fail/config` → `source_config_missing`;
    - `/fail/secret` → `upstream_error` whose message contains `[redacted]` and neither `ACCESS_KEY` nor `api_key=`;
    - `/e2e-mcp/raw` → `unsupported_result`;
    - real Twitter `/twitter/user/_RSSHub` → `source_config_missing`, and `server.log` contains
      `GET /twitter/user/_RSSHub` (executed through the pipeline).
- **S10 Restriction.**
    - These return `route_not_allowed`: `/twitter/trends/23424856`, `/mcp`, `/api/namespace`, `/healthz`.
    - These return `invalid_arguments`: `/e2e-mcp/feed/a?format=json`, `/e2e-mcp/../api/namespace`,
      `/e2e-mcp/%2e%2e/api/namespace`, `e2e-mcp/feed/a`.
    - `{limit:0}` → a tool error starting `Input validation error`.
    - `server.log` has no `GET /twitter/trends`, `GET /api/namespace` or `GET /e2e-mcp/feed/a` lines.
- **S11 Capacity and recovery.**
    - Hold `h1`. Start A `fetch_feed /e2e-mcp/hold/h1` and wait until upstream logs `h1`.
    - Start B `/e2e-mcp/feed/b` (queued), then C `/e2e-mcp/feed/c`. C returns `capacity_exceeded` in < 1 s.
    - Release `h1`: A succeeds, then B succeeds. Upstream order is `h1` before `b`; `c` hits = 0.
    - D `/e2e-mcp/feed/c` → success.
- **S12 Timeouts, slot holding, cache after timeout.**
    - Hold `h2`. Start E `/e2e-mcp/hold/h2` (running), then F `/e2e-mcp/feed/f` (queued).
    - After ~8 s: E → `timeout` with `phase 'running'`; F → `timeout` with `phase 'queued'`.
    - Immediately start J `/e2e-mcp/feed/j`. J is not rejected and has not started: upstream `j` hits = 0 at
      release time.
    - Release `h2` ~1 s later. J succeeds with completion after the release, and upstream `j` follows `h2` in the log.
      `f` hits = 0.
    - G `fetch_feed /e2e-mcp/hold/h2` → success with `cache 'hit'` and `h2` hits = 1.
- **S13 Cross-client same-key coordination.**
    - Hold `h4`. Start RSS `GET /e2e-mcp/hold/h4?key=…` and wait for upstream `h4`.
    - Start MCP `fetch_feed /e2e-mcp/hold/h4`, then release `h4` after 1 s.
    - RSS returns 200; MCP succeeds within 8 s with `cache 'hit'`; `h4` hits = 1.
- **S14 Cancellation.**
    - Hold `h5`. Start K `/e2e-mcp/hold/h5` (running).
    - Start L as a raw legacy JSON-RPC `tools/call` POST for `/e2e-mcp/feed/l` with an `AbortController`, and abort it
      after 500 ms.
    - Start M `/e2e-mcp/feed/m`: it is queued, not `capacity_exceeded`.
    - Release `h5`: K and M succeed; `l` hits = 0.
- **S15 Feeds unchanged after MCP traffic.** Repeat S1 against `/e2e-mcp/feed/rss-z` with the same expected
  statuses, content types and item counts. `/healthz` → 200. Saved: `feed-after.xml`, compared structurally to
  `feed-before.xml`: same channel title and item count, items differ only by id-derived fields.
- **S16 Secrets and browser.**
    - `DUMMY_AUTH` is absent from `server.log` and from every `transcript.jsonl` response body.
    - `ACCESS_KEY` is absent from every MCP response body.
    - `server.log` has no request line containing `key=`, `code=` or `token=` for the MCP-only paths `b`, `c`, `f`,
      `j`, `l`, `m`, `/twitter/user/_RSSHub`.
    - Process-tree samples taken after S6 and S14 (`ps -o pid=,comm= --ppid <server pid>`, recursive) contain no
      `chrom` entry.
- **P1 Production build.**
    - Stop the dev server. Start `node dist/index.mjs` (cwd `W`) with `NODE_ENV=production`, the same MCP/fixture env
      and a fresh `PORT=0`. `dist/index.mjs` is unchanged since `build-node`; its sha256 is recorded before and after.
    - Legacy client initialize succeeds. `search_routes {query:'twitter'}` → the same 8 patterns.
    - `fetch_feed /e2e-mcp/feed/prod` → success, `cache 'miss'`, then `'hit'`.
    - `/twitter/user/_RSSHub` → `source_config_missing`.
    - Credential-less connect succeeds (above); `Origin: https://evil.example` → 403.

    Production mode uses `routes.js` metadata with lazy modules.

Teardown: stop servers (SIGTERM, then SIGKILL after 5 s), close the upstream, remove scratch, write `result.json`
(`passed` only if all of S1–S16 and P1 passed), and print `PASS|FAIL` with the evidence path. On failure, preserve
evidence and do not leave processes running after the qex job ends.

Evidence files: `server.log`, `server-production.log`, `upstream-log.json`, `transcript.jsonl`, `feed-before.xml`,
`feed-after.xml`, `process-samples.txt`, `dist-sha256.txt`, `result.json`.

This journey does **not** verify live Twitter/X, Redis or multi-replica coordination, HTTPS/reverse-proxy
deployment, or any particular agent product. Those are documented in DOC3/DOC4. Future pushes and deployments do not
require rerunning it, and existing unit tests must still be run.

## Open notes

- Live authenticated Twitter pilot, deployment, HTTPS proxy configuration and agent configuration are follow-ups that
  need explicit user authorization and credentials.
- The flake package `pnpmDeps` hash in `flake.nix` will no longer match the new lockfile. Upstream's update workflow
  only runs for `DIYgod`. Refreshing it is a deployment step (DOC3), not part of this feature.
- `with-redis.sh` is a candidate for promotion to repo tooling so future unit runs match CI. Record at delivery.
