/* eslint-disable no-await-in-loop -- These acceptance sequences share mutable server, queue or environment state. */
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startFixtureUpstream } from './fixture-upstream.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
const scratchRoot = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'dev-scratch/rsshub', key, 'e2e');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(path.join(scratchRoot, 'mcp-run-'));
const evidence = path.join(root, 'assets/build/e2e', path.basename(scratch));
await mkdir(evidence, { recursive: true });
const accessKey = randomBytes(32).toString('hex');
const dummyAuth = randomBytes(32).toString('hex');
const defaultPatterns = [
    '/twitter/user/:id/:routeParams?',
    '/twitter/keyword/:keyword/:routeParams?',
    '/twitter/list/:id/:routeParams?',
    '/twitter/media/:id/:routeParams?',
    '/twitter/tweet/:id/status/:status/:original?',
    '/twitter/home/:routeParams?',
    '/twitter/home_latest/:routeParams?',
    '/twitter/likes/:id/:routeParams?',
];
const fixturePatterns = [...['/feed/:id', '/hold/:id', '/fail/:kind', '/empty', '/empty-ok', '/raw'].map((p) => `/e2e-mcp${p}`), '/e2e-mcp/', '/e2e-mcp/metadata/:id?'];
const expectedMetadataDescription =
    'Visit "https://example.com"\nSee [site](https://example.com)\n<a href="https://example.com/docs">docs</a>\nWindows C:\\notes\\file\nCredential: [redacted]\n(https://example.com/private[redacted])';
const transcript = [];
const samples = [];
const clients = [];
const report = { startedAt: new Date().toISOString(), passed: false, steps: [] };
let child;
let log;
let base;
const upstream = await startFixtureUpstream();
const routes = path.join(scratch, 'routes');
await mkdir(routes);
await copyFile(new URL('fixtures/e2e-mcp.mjs', import.meta.url), path.join(routes, 'e2e-mcp.mjs'));
const env = {
    ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TZ', 'SSL_CERT_FILE', 'NIX_SSL_CERT_FILE'].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
    PORT: '0',
    LISTEN_INADDR_ANY: 'false',
    ENABLE_CLUSTER: 'false',
    CACHE_TYPE: 'memory',
    NO_LOGFILES: 'true',
    DOTENV_CONFIG_PATH: path.join(scratch, 'absent.env'),
    USER_ROUTES_PATH: routes,
    E2E_MCP_UPSTREAM: upstream.url,
    ACCESS_KEY: accessKey,
    MCP_ENABLE: 'true',
    MCP_MAX_CONCURRENCY: '1',
    MCP_MAX_QUEUE: '1',
    MCP_TIMEOUT: '8',
    MCP_MAX_ITEMS: '10',
    MCP_MAX_RESPONSE_BYTES: '16384',
    MCP_ROUTES: [...defaultPatterns, ...fixturePatterns].join(','),
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const title = (xml) => xml.match(/<title>(.*?)<\/title>/s)?.[1];
async function digest() {
    const bytes = await readFile(path.join(root, 'dist/index.mjs'));
    return createHash('sha256').update(bytes).digest('hex');
}
async function expectAbort(pending) {
    try {
        const response = await pending;
        await response.text();
        assert.fail('Expected HTTP request abort');
    } catch (error) {
        assert.equal(error.name, 'AbortError');
    }
}

async function stop() {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('close', resolve));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
    }
    if (log) {
        await new Promise((resolve) => log.end(resolve));
    }
}
async function start(production = false) {
    log = createWriteStream(path.join(evidence, production ? 'server-production.log' : 'server.log'));
    // Observe the bound random port without changing the production bundle.
    const observer =
        "import{Server}from'node:http';const listen=Server.prototype.listen;Server.prototype.listen=function(...args){if(args[0]===0||args[0]?.port===0)this.once('listening',()=>process.send?.({port:this.address().port}));return listen.apply(this,args)}";
    child = fork(path.join(root, production ? 'dist/index.mjs' : 'scripts/e2e/server.ts'), [], {
        cwd: root,
        env: { ...env, NODE_ENV: production ? 'production' : 'dev' },
        execArgv: production ? ['--import', `data:text/javascript,${encodeURIComponent(observer)}`] : ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Startup exceeded 60s')), 60000);
        child.once('message', (message) => {
            clearTimeout(timer);
            resolve(message.port);
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Startup exit ${code}`));
        });
    });
    assert.ok(Number.isSafeInteger(port) && port > 0, 'Expected RSSHub random loopback port');
    base = `http://127.0.0.1:${port}`;
}
async function capture(url, init) {
    const response = await fetch(url, init);
    transcript.push({
        method: init?.method || 'GET',
        url: new URL(url).pathname,
        origin: new Headers(init?.headers).has('origin'),
        authorization: new Headers(init?.headers).has('authorization'),
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: await response.clone().text(),
    });
    return response;
}
async function connect(modern = false) {
    const client = new Client({ name: 'rsshub-e2e', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: capture }));
    return client;
}
const initialize = (headers = {}, suffix = '') =>
    capture(`${base}/mcp${suffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }),
    });
const call = (client, pathname, options = {}) => client.callTool({ name: 'fetch_feed', arguments: { path: pathname, ...options } });
const success = (result) => {
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
};
const errorCode = (result, code) => {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, code);
    return result.structuredContent.error;
};
async function feeds(id, filename) {
    assert.equal((await fetch(`${base}/healthz?key=${accessKey}`)).status, 200);
    assert.equal((await fetch(`${base}/e2e-mcp/feed/${id}`)).status, 403);
    const rss = await fetch(`${base}/e2e-mcp/feed/${id}?key=${accessKey}`);
    assert.equal(rss.status, 200);
    assert.match(rss.headers.get('content-type'), /xml/);
    const xml = await rss.text();
    assert.match(xml, /<rss\b/);
    assert.equal((xml.match(/<item>/g) || []).length, 3);
    await writeFile(path.join(evidence, filename), xml);
    const json = await fetch(`${base}/e2e-mcp/feed/${id}?format=json&key=${accessKey}`);
    assert.equal(json.status, 200);
    assert.equal((await json.json()).items.length, 3);
    assert.equal(upstream.hits(`/feed/${id}`), 2);
    return xml;
}
async function step(id, expected, run) {
    try {
        const actual = await run();
        report.steps.push({ id, expected, actual: actual || 'all assertions passed', passed: true, evidence: ['server.log', 'transcript.jsonl', 'upstream-log.json'] });
    } catch (error) {
        report.steps.push({ id, expected, actual: error.stack || String(error), passed: false });
        throw error;
    }
}
function sample() {
    const pending = [child.pid];
    while (pending.length) {
        const pid = pending.shift();
        let rows = '';
        try {
            rows = execFileSync('ps', ['-o', 'pid=,comm=', '--ppid', String(pid)], { encoding: 'utf8' });
        } catch {
            /* No descendants. */
        }
        samples.push(`${pid}:\n${rows}`);
        assert.doesNotMatch(rows, /chrom/i);
        const childRows = rows.trim().split('\n').filter(Boolean);
        for (const row of childRows) {
            pending.push(Number(row.trim().split(/\s+/, 1)[0]));
        }
    }
}
process.once('SIGTERM', () => {
    child?.kill('SIGTERM');
    process.exitCode = 1;
});
process.once('SIGINT', () => {
    child?.kill('SIGTERM');
    process.exitCode = 1;
});
try {
    await start();
    let legacy;
    let modern;
    let before;
    await step('S1', 'baseline health, protected RSS and JSON feeds, two upstream hits', async () => {
        before = await feeds('rss-a', 'feed-before.xml');
    });
    await step('S2', 'unauthenticated MCP 200, ignored credentials, Origin 403, GET/DELETE 405', async () => {
        for (const [headers, suffix] of [
            [{}, ''],
            [{ Authorization: `Bearer ${dummyAuth}` }, ''],
            [{}, '?key=wrong'],
        ]) {
            const response = await initialize(headers, suffix);
            assert.equal(response.status, 200, `POST /mcp → ${response.status}, expected 200 initialize`);
            const body = await response.text();
            const message = response.headers.get('content-type')?.includes('text/event-stream')
                ? JSON.parse(
                      body
                          .split('\n')
                          .find((line) => line.startsWith('data: '))
                          .slice(6)
                  )
                : JSON.parse(body);
            assert.equal(message.result.serverInfo.name, 'rsshub');
        }
        const hits = upstream.hits();
        const denied = await initialize({ Origin: 'https://evil.example' });
        assert.equal(denied.status, 403);
        assert.deepEqual(await denied.json(), { error: 'forbidden_origin' });
        assert.equal(upstream.hits(), hits);
        for (const method of ['GET', 'DELETE']) {
            assert.equal((await capture(`${base}/mcp`, { method })).status, 405);
        }
        assert.match(await readFile(path.join(evidence, 'server.log'), 'utf8'), /MCP endpoint mounted at \/mcp without authentication/);
    });
    await step('S3', 'legacy handshake and exactly two typed read-only tools', async () => {
        legacy = await connect();
        assert.equal(legacy.getServerVersion().name, 'rsshub');
        const tools = (await legacy.listTools()).tools;
        assert.deepEqual(tools.map((t) => t.name).toSorted(), ['fetch_feed', 'search_routes']);
        for (const tool of tools) {
            assert.ok(tool.inputSchema);
            assert.ok(tool.outputSchema);
            assert.equal(tool.annotations.readOnlyHint, true);
        }
    });
    await step('S4', 'modern discovery and same tools', async () => {
        modern = await connect(true);
        assert.deepEqual((await modern.listTools()).tools.map((t) => t.name).toSorted(), ['fetch_feed', 'search_routes']);
        assert.equal(success(await modern.callTool({ name: 'search_routes', arguments: { query: 'twitter' } })).total, 8);
    });
    await step('S5', 'allowlisted metadata and pagination', async () => {
        const found = success(await legacy.callTool({ name: 'search_routes', arguments: { query: 'twitter' } }));
        assert.equal(found.total, 8);
        assert.deepEqual(found.routes.map((r) => r.path).toSorted(), [...defaultPatterns].toSorted());
        const user = found.routes.find((r) => r.path.startsWith('/twitter/user/'));
        assert.ok(user.name);
        assert.deepEqual(
            user.parameters.map(({ name, optional }) => ({ name, optional })),
            [
                { name: 'id', optional: false },
                { name: 'routeParams', optional: true },
            ]
        );
        assert.ok(user.requiresConfig.some((r) => r.name === 'TWITTER_AUTH_TOKEN'));
        assert.ok(user.requiresConfig.every((r) => Object.keys(r).toSorted().join(',') === 'name,optional'));
        const all = success(await legacy.callTool({ name: 'search_routes', arguments: { limit: 50 } }));
        assert.equal(all.total, 16);
        assert.deepEqual(
            all.routes.map((r) => r.path),
            all.routes.map((r) => r.path).toSorted()
        );
        assert.equal(success(await legacy.callTool({ name: 'search_routes', arguments: { limit: 3 } })).nextOffset, 3);
        for (const client of [legacy, modern]) {
            const root = success(await client.callTool({ name: 'search_routes', arguments: { query: 'canonical' } }));
            assert.equal(root.total, 1);
            assert.equal(root.routes[0].path, '/e2e-mcp');
            assert.equal(success(await call(client, root.routes[0].path)).itemCount, 3);
            const metadata = success(await client.callTool({ name: 'search_routes', arguments: { query: 'metadata formatting' } }));
            assert.equal(metadata.routes[0].description, expectedMetadataDescription);
            assert.equal(metadata.routes[0].parameters[0].default, '[redacted]');
        }
    });
    await step('S6', 'success, content/item bounds, cache in both directions', async () => {
        const first = success(await call(legacy, '/e2e-mcp/feed/big', { limit: 5 }));
        assert.equal(first.itemCount, 30);
        assert.equal(first.returnedCount, 5);
        assert.equal(first.truncation.items, true);
        assert.equal(first.truncation.content, true);
        assert.ok(first.items.every((i) => i.content.length <= 4000 && i.contentFormat === 'text' && i.link.startsWith('https://example.com/') && Number.isFinite(Date.parse(i.pubDate))));
        assert.deepEqual(
            first.items.map((i) => i.pubDate),
            first.items
                .map((i) => i.pubDate)
                .toSorted()
                .toReversed()
        );
        assert.equal(first.snapshot.cache, 'miss');
        assert.equal(first.snapshot.pagination, 'none');
        const next = success(await call(modern, '/e2e-mcp/feed/big', { limit: 5 }));
        assert.equal(next.snapshot.cache, 'hit');
        assert.equal(next.snapshot.builtAt, first.snapshot.builtAt);
        assert.equal((await fetch(`${base}/e2e-mcp/feed/big?key=${accessKey}`)).headers.get('RSSHub-Cache-Status'), 'HIT');
        assert.equal(upstream.hits('/feed/big'), 1);
        assert.equal(success(await call(legacy, '/e2e-mcp/feed/rss-a')).snapshot.cache, 'hit');
        assert.equal(upstream.hits('/feed/rss-a'), 2);
        sample();
    });
    await step('S7', 'UTF-8 byte bound and matching text JSON', async () => {
        const raw = await call(legacy, '/e2e-mcp/feed/big', { limit: 10, content: 'html' });
        const result = success(raw);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384);
        assert.equal(result.truncation.bytes, true);
        assert.ok(result.returnedCount < 10);
        assert.deepEqual(JSON.parse(raw.content[0].text), result);
    });
    await step('S8', 'empty errors and allowEmpty success', async () => {
        errorCode(await call(legacy, '/e2e-mcp/empty'), 'empty_result');
        const empty = success(await call(legacy, '/e2e-mcp/empty-ok'));
        assert.deepEqual(empty.items, []);
        assert.equal(empty.itemCount, 0);
    });
    await step('S9', 'closed error taxonomy including real missing Twitter config', async () => {
        const rate = errorCode(await call(legacy, '/e2e-mcp/fail/rate-limit'), 'upstream_rate_limited');
        assert.equal(rate.retryAfterSeconds, 120);
        assert.equal(rate.retryable, true);
        const twitterRate = errorCode(await call(legacy, '/e2e-mcp/fail/twitter-429'), 'upstream_rate_limited');
        assert.ok(!('retryAfterSeconds' in twitterRate));
        errorCode(await call(legacy, '/e2e-mcp/fail/upstream'), 'upstream_error');
        errorCode(await call(legacy, '/e2e-mcp/fail/config'), 'source_config_missing');
        const secret = errorCode(await call(legacy, '/e2e-mcp/fail/secret'), 'upstream_error');
        assert.match(secret.message, /\[redacted\]/);
        assert.ok(!secret.message.includes(accessKey));
        assert.doesNotMatch(secret.message, /api_key=/);
        errorCode(await call(legacy, '/e2e-mcp/raw'), 'unsupported_result');
        errorCode(await call(legacy, '/twitter/user/_RSSHub'), 'source_config_missing');
        assert.match(await readFile(path.join(evidence, 'server.log'), 'utf8'), /GET \/twitter\/user\/_RSSHub/);
    });
    await step('S10', 'restriction before dispatch and SDK validation', async () => {
        for (const p of ['/twitter/trends/23424856', '/mcp', '/api/namespace', '/healthz', '/e2e-mcp/blocked']) {
            errorCode(await call(legacy, p), 'route_not_allowed');
        }
        for (const p of ['/e2e-mcp/feed/a?format=json', '/e2e-mcp/../api/namespace', '/e2e-mcp/%2e%2e/api/namespace', 'e2e-mcp/feed/a']) {
            errorCode(await call(legacy, p), 'invalid_arguments');
        }
        const invalid = await call(legacy, '/e2e-mcp/feed/a', { limit: 0 });
        assert.equal(invalid.isError, true);
        assert.match(invalid.content[0].text, /^Input validation error/);
        assert.doesNotMatch(await readFile(path.join(evidence, 'server.log'), 'utf8'), /GET \/(?:twitter\/trends|api\/namespace|e2e-mcp\/feed\/a\b)/);
    });
    await step('S11', 'capacity, FIFO and recovery', async () => {
        upstream.hold('h1');
        const a = call(legacy, '/e2e-mcp/hold/h1');
        await upstream.waitFor('/hold/h1');
        const b = call(legacy, '/e2e-mcp/feed/b');
        await delay(100);
        const at = performance.now();
        errorCode(await call(legacy, '/e2e-mcp/feed/c'), 'capacity_exceeded');
        assert.ok(performance.now() - at < 1000);
        upstream.release('h1');
        success(await a);
        success(await b);
        assert.equal(upstream.hits('/feed/c'), 0);
        success(await call(legacy, '/e2e-mcp/feed/c'));
        assert.ok(upstream.log().findIndex((r) => r.path === '/hold/h1') < upstream.log().findIndex((r) => r.path === '/feed/b'));
    });
    await step('S12', 'queue/running deadlines hold slots and populate cache', async () => {
        upstream.hold('h2');
        const e = call(legacy, '/e2e-mcp/hold/h2');
        await upstream.waitFor('/hold/h2');
        const f = call(legacy, '/e2e-mcp/feed/f');
        assert.equal(errorCode(await e, 'timeout').phase, 'running');
        assert.equal(errorCode(await f, 'timeout').phase, 'queued');
        const j = call(legacy, '/e2e-mcp/feed/j');
        await delay(1000);
        assert.equal(upstream.hits('/feed/j'), 0);
        upstream.release('h2');
        success(await j);
        assert.equal(upstream.hits('/feed/f'), 0);
        assert.equal(success(await call(legacy, '/e2e-mcp/hold/h2')).snapshot.cache, 'hit');
        assert.equal(upstream.hits('/hold/h2'), 1);
    });
    await step('S13', 'RSS claim shares same-key cache with MCP', async () => {
        upstream.hold('h4');
        const rss = fetch(`${base}/e2e-mcp/hold/h4?key=${accessKey}`);
        await upstream.waitFor('/hold/h4');
        const mcp = call(legacy, '/e2e-mcp/hold/h4');
        await delay(1000);
        upstream.release('h4');
        assert.equal((await rss).status, 200);
        assert.equal(success(await mcp).snapshot.cache, 'hit');
        assert.equal(upstream.hits('/hold/h4'), 1);
    });
    await step('S14', 'HTTP abort removes queued task', async () => {
        upstream.hold('h5');
        const k = call(legacy, '/e2e-mcp/hold/h5');
        await upstream.waitFor('/hold/h5');
        const controller = new AbortController();
        const l = expectAbort(
            fetch(`${base}/mcp`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'fetch_feed', arguments: { path: '/e2e-mcp/feed/l' } } }),
            })
        );
        await delay(500);
        controller.abort();
        await l;
        await delay(100);
        const m = call(legacy, '/e2e-mcp/feed/m');
        await delay(100);
        upstream.release('h5');
        success(await k);
        success(await m);
        assert.equal(upstream.hits('/feed/l'), 0);
        sample();
    });
    await step('S15', 'external feeds unchanged after MCP traffic', async () => {
        const after = await feeds('rss-z', 'feed-after.xml');

        assert.equal(title(before), title(after));
        assert.equal((await fetch(`${base}/healthz?key=${accessKey}`)).status, 200);
    });
    await step('S16', 'no credentials in MCP responses/logs; no browser process', async () => {
        const logs = await readFile(path.join(evidence, 'server.log'), 'utf8');
        assert.ok(!logs.includes(dummyAuth));
        for (const entry of transcript) {
            assert.ok(!entry.body.includes(dummyAuth));
            assert.ok(!entry.body.includes(accessKey));
        }
        assert.doesNotMatch(logs, /GET \/(?:e2e-mcp\/feed\/[bcfjlm]|twitter\/user\/_RSSHub)[^\n]*(?:key=|code=|token=)/);
        assert.ok(samples.every((s) => !/chrom/i.test(s)));
    });
    if (process.argv.includes('--skip-production')) {
        report.steps.push({ id: 'P1', passed: false, status: 'unrun', actual: '--skip-production' });
    } else {
        await step('P1', 'unchanged production bundle serves real MCP and fixture cache', async () => {
            const beforeHash = await digest();
            await stop();
            await start(true);
            const client = await connect();
            const found = success(await client.callTool({ name: 'search_routes', arguments: { query: 'twitter' } }));
            assert.deepEqual(found.routes.map((r) => r.path).toSorted(), [...defaultPatterns].toSorted());
            assert.equal(success(await call(client, '/e2e-mcp/feed/prod')).snapshot.cache, 'miss');
            assert.equal(success(await call(client, '/e2e-mcp/feed/prod')).snapshot.cache, 'hit');
            const root = success(await client.callTool({ name: 'search_routes', arguments: { query: 'canonical' } }));
            assert.equal(root.routes[0].path, '/e2e-mcp');
            assert.equal(success(await call(client, root.routes[0].path)).snapshot.cache, 'miss');
            assert.equal(success(await call(client, root.routes[0].path)).snapshot.cache, 'hit');
            const metadata = success(await client.callTool({ name: 'search_routes', arguments: { query: 'metadata formatting' } }));
            assert.equal(metadata.routes[0].description, expectedMetadataDescription);

            errorCode(await call(client, '/twitter/user/_RSSHub'), 'source_config_missing');
            assert.equal((await initialize({ Origin: 'https://evil.example' })).status, 403);
            const afterHash = await digest();
            assert.equal(beforeHash, afterHash);
            await writeFile(path.join(evidence, 'dist-sha256.txt'), `${beforeHash}\n${afterHash}\n`);
        });
    }
    report.passed = report.steps.length === 17 && report.steps.every((s) => s.passed);
} catch (error) {
    report.error = error.stack || String(error);
    process.stderr.write(`${report.error}\n`);
} finally {
    await stop();
    await upstream.close();
    await rm(scratch, { recursive: true, force: true });
    await writeFile(path.join(evidence, 'upstream-log.json'), JSON.stringify(upstream.log(), null, 2));
    await writeFile(path.join(evidence, 'transcript.jsonl'), transcript.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(path.join(evidence, 'process-samples.txt'), samples.join('\n'));
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`${report.passed ? 'PASS' : 'FAIL'}: ${evidence}\n`);
    if (!report.passed) {
        process.exitCode = 1;
    }
}
