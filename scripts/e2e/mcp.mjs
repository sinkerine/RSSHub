/* eslint-disable no-await-in-loop -- These acceptance sequences share mutable server, queue or environment state. */
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import Parser from 'rss-parser';

import { startTwitterFixtureUpstream } from './fixture-upstream.mjs';

async function capability() {
    const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
    const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const scratchRoot = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'dev-scratch/rsshub', key, 'e2e');
    await mkdir(scratchRoot, { recursive: true });
    const scratch = await mkdtemp(path.join(scratchRoot, 'mcp-run-capability-'));
    const evidence = path.join(root, 'assets/build/e2e', path.basename(scratch));
    await mkdir(evidence, { recursive: true });
    const outboundPath = path.join(evidence, 'outbound.jsonl');
    await writeFile(outboundPath, '');
    const report = {
        mode: 'capability',
        startedAt: new Date().toISOString(),
        passed: false,
        sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        steps: [],
        command: 'agent-job run --e2e mcp -- nix develop --impure -c node scripts/e2e/mcp.mjs --capability',
    };
    const clients = [];
    const transcript = [];
    const controller = new AbortController();
    const shutdown = () => controller.abort(new Error('Capability interrupted'));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    let child;
    let upstream;
    let log;
    const watchdog = setTimeout(() => {
        shutdown();
        child?.kill('SIGTERM');
    }, 150000);
    const checkpoint = () => writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    try {
        await checkpoint();
        upstream = await startTwitterFixtureUpstream();
        const routes = path.join(scratch, 'routes');
        await mkdir(routes);
        await copyFile(new URL('fixtures/e2e-smoke.mjs', import.meta.url), path.join(routes, 'e2e-smoke.mjs'));
        const accessKey = randomBytes(32).toString('hex');
        const env = {
            ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TZ', 'SSL_CERT_FILE', 'NIX_SSL_CERT_FILE'].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
            PORT: '0',
            LISTEN_INADDR_ANY: 'false',
            ENABLE_CLUSTER: 'false',
            CACHE_TYPE: 'memory',
            NO_LOGFILES: 'true',
            NODE_ENV: 'dev',
            DOTENV_CONFIG_PATH: path.join(scratch, 'absent.env'),
            USER_ROUTES_PATH: routes,
            ACCESS_KEY: accessKey,
            MCP_ENABLE: 'true',
            TWITTER_THIRD_PARTY_API: upstream.url,
            E2E_OUTBOUND_LOG: outboundPath,
            E2E_FIXTURE_PORT: new URL(upstream.url).port,
        };
        const execArgv = ['--import', fileURLToPath(new URL('twitter-outbound-guard.mjs', import.meta.url)), '--import', 'tsx'];
        report.serverCommand = { executable: process.execPath, execArgv, entry: 'scripts/e2e/server.ts' };
        report.isolation = { upstream: upstream.url, cache: 'memory', authToken: 'absent', developerCredentials: 'absent', accessKey: 'random, not retained' };
        log = createWriteStream(path.join(evidence, 'server.log'));
        child = fork(path.join(root, 'scripts/e2e/server.ts'), [], { cwd: root, env, execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Startup exceeded 60s')), 60000);
            const settle = (error, value) => {
                clearTimeout(timer);
                controller.signal.removeEventListener('abort', abort);
                if (error) {
                    reject(error);
                } else {
                    resolve(value);
                }
            };
            const abort = () => settle(controller.signal.reason);
            controller.signal.addEventListener('abort', abort, { once: true });
            child.once('message', (message) => settle(undefined, message.port));
            child.once('error', (error) => settle(error));
            child.once('exit', (code) => settle(new Error(`Startup exit ${code}`)));
        });
        assert.ok(Number.isSafeInteger(port) && port > 0);
        const base = `http://127.0.0.1:${port}`;
        const capture = async (url, init) => {
            const response = await fetch(url, { ...init, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
            transcript.push({ path: new URL(url).pathname, status: response.status, contentType: response.headers.get('content-type'), body: await response.clone().text() });
            return response;
        };
        assert.equal((await capture(`${base}/healthz?key=${accessKey}`)).status, 200);
        assert.equal((await capture(`${base}/twitter/user/rsshub_fixture`)).status, 403);
        assert.equal(upstream.log().length, 0, 'Unauthenticated RSS must not reach source');
        const response = await capture(`${base}/twitter/user/rsshub_fixture?key=${accessKey}`);
        assert.equal(response.status, 200, 'Baseline Twitter RSS acquisition must succeed');
        const xml = await response.text();
        await writeFile(path.join(evidence, 'twitter-user.xml'), xml);
        const parsed = await new Parser().parseString(xml);
        assert.equal(parsed.items.length, 1);
        assert.equal(parsed.items[0].link, 'https://x.com/rsshub_fixture/status/900000000000000101');
        assert.match(parsed.items[0].content || parsed.items[0].contentSnippet || '', /Synthetic capability acquisition post/);
        assert.deepEqual(
            upstream.log().map((entry) => entry.operation),
            ['UserByScreenName', 'UserTweets']
        );
        assert.equal(upstream.log()[0].variables.screen_name, 'rsshub_fixture');
        assert.equal(upstream.log()[1].variables.userId, '900000000000000001');
        assert.equal(upstream.log()[1].variables.count, 20);
        assert.match(upstream.log()[0].path, /\/Gb-d6r0vxPOADdG62OEBpQ\/UserByScreenName$/);
        const cached = await capture(`${base}/twitter/user/rsshub_fixture?key=${accessKey}`);
        assert.equal(cached.status, 200);
        assert.equal(cached.headers.get('RSSHub-Cache-Status'), 'HIT');
        assert.equal(await cached.text(), xml);
        assert.equal(upstream.log().length, 2);
        report.steps.push({ id: 'acquisition', passed: true, actual: 'Real cached RSS adapter: parsed synthetic post; lookup and timeline hits; second RSS served from cache; ACCESS_KEY enforced' });
        await checkpoint();
        for (const modern of [false, true]) {
            const client = new Client({ name: 'rsshub-capability', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
            clients.push(client);
            await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: capture }));
            const tools = await client.listTools();
            await writeFile(path.join(evidence, modern ? 'tools-modern.json' : 'tools-legacy.json'), JSON.stringify(tools, null, 2) + '\n');
            const names = tools.tools.map((tool) => tool.name).toSorted();
            const missing = ['twitter_search', 'twitter_user_tweets', 'twitter_get_tweet'].filter((name) => !names.includes(name));
            report.steps.push({ id: modern ? 'discovery-modern' : 'discovery-legacy', passed: true, names, missing, featureStatus: missing.length ? 'EXPECTED feature-red on baseline' : 'feature-present' });
        }
        const outbound = (await readFile(outboundPath, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        assert.ok(outbound.some((entry) => entry.event === 'installed'));
        for (const host of ['x.com', 'cdn.jsdelivr.net']) {
            assert.ok(
                outbound.some((entry) => entry.event === 'blocked' && entry.host === host),
                `Expected blocked discovery: ${host}`
            );
        }
        assert.ok(
            outbound.some((entry) => entry.event === 'connected'),
            'Fixture transport must pass guard'
        );
        assert.ok(outbound.every((entry) => entry.event !== 'violation'));
        assert.match(await readFile(path.join(evidence, 'server.log'), 'utf8'), /Using fallback|using fallback/);
        report.steps.push({ id: 'outbound-guard', passed: true, actual: 'Discovery denied; built-in query ID reached fixture; only fixture socket connections allowed' });
        report.passed = true;
    } catch (error) {
        report.error = error.stack || String(error);
        process.stderr.write(`${report.error}\n`);
    } finally {
        clearTimeout(watchdog);
        controller.abort();
        await Promise.allSettled(clients.map((client) => client.close()));
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
        if (upstream) {
            await upstream.close();
        }
        report.blockedOutboundAttempts = (await readFile(outboundPath, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        if (report.blockedOutboundAttempts.some((entry) => entry.event === 'violation')) {
            report.passed = false;
        }
        await writeFile(path.join(evidence, 'upstream-log.json'), JSON.stringify(upstream?.log() || [], null, 2) + '\n');
        await writeFile(path.join(evidence, 'transcript.jsonl'), transcript.map((row) => JSON.stringify(row)).join('\n') + '\n');
        await rm(scratch, { recursive: true, force: true });
        report.cleanup = 'clients closed; server reaped; fixture closed; own scratch removed';
        report.finishedAt = new Date().toISOString();
        await checkpoint();
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        process.stdout.write(`${report.passed ? 'CAPABILITY_PASS' : 'CAPABILITY_BLOCKED'}: ${evidence}\n`);
        if (!report.passed) {
            process.exitCode = 1;
        }
    }
}

if (process.argv.includes('--capability')) {
    await capability();
    process.exit(process.exitCode || 0);
}

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
const scratchRoot = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'dev-scratch/rsshub', key, 'e2e');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(path.join(scratchRoot, 'mcp-run-'));
const evidence = path.join(root, 'assets/build/e2e', path.basename(scratch));
await mkdir(evidence, { recursive: true });
const accessKey = randomBytes(32).toString('hex');
const outboundPath = path.join(evidence, 'outbound.jsonl');
await writeFile(outboundPath, '');
const report = {
    startedAt: new Date().toISOString(),
    passed: false,
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    steps: [],
    commands: [],
    clock: 'Server wall clock fixed at 2025-02-01T00:00:00Z and feed request Host fixed to rsshub-fixture.example for byte-identical RSS comparisons; real timers/performance clock retained',
};
const upstream = await startTwitterFixtureUpstream();
const routes = path.join(scratch, 'routes');
await mkdir(routes);
await copyFile(new URL('fixtures/e2e-smoke.mjs', import.meta.url), path.join(routes, 'e2e-smoke.mjs'));
const env = {
    ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TZ', 'SSL_CERT_FILE', 'NIX_SSL_CERT_FILE'].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
    PORT: '0',
    LISTEN_INADDR_ANY: 'false',
    ENABLE_CLUSTER: 'false',
    CACHE_TYPE: 'memory',
    NO_LOGFILES: 'true',
    DOTENV_CONFIG_PATH: path.join(scratch, 'absent.env'),
    USER_ROUTES_PATH: routes,
    ACCESS_KEY: accessKey,
    MCP_ENABLE: 'true',
    MCP_MAX_CONCURRENCY: '1',
    MCP_MAX_QUEUE: '1',
    MCP_TIMEOUT: '2',
    MCP_MAX_RESPONSE_BYTES: '65536',
    REQUEST_RETRY: '0',
    TWITTER_THIRD_PARTY_API: upstream.url,
    E2E_OUTBOUND_LOG: outboundPath,
    E2E_FIXTURE_PORT: new URL(upstream.url).port,
};
const clients = [];
const transcript = [];
const interrupted = new AbortController();
let child;
let log;
let base;
let session;
const abort = () => {
    interrupted.abort();
    child?.kill('SIGTERM');
};
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
const watchdog = setTimeout(abort, 12 * 60000);
const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
const checkpoint = () => writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
async function step(id, expected, run) {
    try {
        const actual = await run();
        report.steps.push({ id, session, expected, actual: actual || 'all assertions passed', passed: true });
        await checkpoint();
    } catch (error) {
        report.steps.push({ id, session, expected, actual: error.stack || String(error), passed: false });
        throw error;
    }
}
async function stop() {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((resolve) => child.once('close', resolve));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await closed;
        clearTimeout(timer);
    }
    if (!log) {
        return;
    }

    await new Promise((resolve) => log.end(resolve));
    log = undefined;
}
async function start(production = false, overrides = {}, label = production ? 'production' : 'dev') {
    await stop();
    session = label;
    log = createWriteStream(path.join(evidence, `server-${label}.log`));
    const observer =
        "import{Server}from'node:http';const listen=Server.prototype.listen;Server.prototype.listen=function(...args){if(args[0]===0||args[0]?.port===0)this.once('listening',()=>process.send?.({port:this.address().port}));return listen.apply(this,args)};const D=Date;globalThis.Date=class extends D{constructor(...args){super(...(args.length?args:['2025-02-01T00:00:00Z']))}static now(){return 1738368000000}}";
    const execArgv = ['--import', fileURLToPath(new URL('twitter-outbound-guard.mjs', import.meta.url)), '--import', `data:text/javascript,${encodeURIComponent(observer)}`, ...(production ? [] : ['--import', 'tsx'])];
    const entry = production ? 'dist/index.mjs' : 'scripts/e2e/server.ts';
    report.commands.push({ session, executable: process.execPath, execArgv, entry });
    child = fork(path.join(root, entry), [], { cwd: root, env: { ...env, ...overrides, NODE_ENV: production ? 'production' : 'dev' }, execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Startup exceeded 60s')), 60000);
        const settle = (error, value) => {
            clearTimeout(timer);
            if (error) {
                reject(error);
            } else {
                resolve(value);
            }
        };
        child.once('message', (message) => settle(undefined, message.port));
        child.once('error', (error) => settle(error));
        child.once('exit', (code) => settle(new Error(`Startup exit ${code}`)));
    });
    assert.ok(Number.isSafeInteger(port) && port > 0);
    base = `http://127.0.0.1:${port}`;
    assert.equal((await capture(`${base}/healthz?key=${accessKey}`)).status, 200);
}
async function capture(url, init) {
    const response = await fetch(url, { ...init, signal: AbortSignal.any([interrupted.signal, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(60000)]) });
    transcript.push({ session, path: new URL(url).pathname, method: init?.method || 'GET', status: response.status, contentType: response.headers.get('content-type'), body: await response.clone().text() });
    return response;
}
async function connect(modern = false) {
    const client = new Client({ name: 'rsshub-twitter-e2e', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: capture }));
    return client;
}
function success(result) {
    assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= 65536);
    return result.structuredContent;
}
function failure(result, code) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, code);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result.structuredContent.error;
}
const search = (client, query, args = {}) => client.callTool({ name: 'twitter_search', arguments: { query, ...args } });
const userTweets = (client, user = 'rsshub_test', args = {}) => client.callTool({ name: 'twitter_user_tweets', arguments: { user, ...args } });
const rawSearch = (query, signal) =>
    capture(`${base}/mcp`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'twitter_search', arguments: { query } } }),
    });
async function expectAbort(pending) {
    try {
        const response = await pending;
        await response.text();
        assert.fail('Expected HTTP abort');
    } catch (error) {
        assert.equal(error.name, 'AbortError');
    }
}
async function canonicalFeed(url) {
    const response = await new Promise((resolve, reject) => {
        get(url, { headers: { host: 'rsshub-fixture.example' }, signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(60000)]) }, (incoming) => {
            void text(incoming)
                .then((body) => resolve(new Response(body, { status: incoming.statusCode, headers: incoming.headers })))
                .catch(reject);
        }).once('error', reject);
    });
    transcript.push({ session, path: new URL(url).pathname, method: 'GET', status: response.status, contentType: response.headers.get('content-type'), body: await response.clone().text() });
    return response;
}
async function feedSnapshot() {
    const values = [];
    for (const pathname of ['/test/1', '/e2e-smoke/feed', '/twitter/user/rsshub_fixture', '/twitter/keyword/fixture']) {
        for (const format of ['rss', 'json']) {
            const suffix = format === 'json' ? '?format=json' : '';
            assert.equal((await capture(base + pathname + suffix)).status, 403);
            const response = await canonicalFeed(base + pathname + suffix + (suffix ? '&' : '?') + `key=${accessKey}`);
            assert.equal(response.status, 200);
            const body = await response.text();
            if (format === 'rss') {
                assert.ok((await new Parser().parseString(body)).items.length);
            } else {
                assert.ok(JSON.parse(body).items.length);
            }
            values.push({ pathname, format, body, etag: response.headers.get('etag') });
        }
    }
    await writeFile(path.join(evidence, `feeds-${session}.json`), JSON.stringify(values, null, 2));
    return values;
}
async function discovery(prefix) {
    let main;
    for (const modern of [false, true]) {
        const client = await connect(modern);
        const tools = (await client.listTools()).tools;
        assert.deepEqual(tools.map((tool) => tool.name).toSorted(), ['twitter_get_tweet', 'twitter_search', 'twitter_user_tweets']);
        for (const tool of tools) {
            assert.equal(tool.annotations.readOnlyHint, true);
            assert.equal(tool.annotations.openWorldHint, true);
            assert.equal(tool.inputSchema.additionalProperties, false);
            assert.ok(tool.outputSchema);
        }
        await writeFile(path.join(evidence, `tools-${prefix}-${modern ? 'modern' : 'legacy'}.json`), JSON.stringify(tools, null, 2));
        if (!modern) {
            main = client;
        }
    }
    return main;
}
async function basics(client, prefix) {
    await step(`${prefix}J2`, 'query reaches real source byte-identically; schema-valid native JSON, media and normalization', async () => {
        const query = '"quoted" #tag % / ? 中文';
        const result = success(await search(client, query, { limit: 5 }));
        assert.equal(upstream.log().at(-1).variables.rawQuery, query);
        assert.equal(result.returnedCount, 5);
        assert.equal(result.sourceCount, 20);
        assert.equal(result.pagination, 'cursor');
        assert.ok(result.nextCursor);
        assert.match(result.tweets[0].text, / & https:\/\/example.com\/docs\?q=fixture/);
        assert.equal(result.tweets[0].media[0].type, 'photo');
        assert.ok(!('legacy' in result.tweets[0]));
        assert.equal(result.query, query);
    });
    await step(`${prefix}J3`, 'defaults, replies, repost filter, @ and numeric lookup plus profile', async () => {
        const defaults = success(await userTweets(client));
        assert.equal(defaults.user.username, 'rsshub_test');
        assert.equal(defaults.tweets[0].isPinned, true);
        assert.ok(defaults.tweets.every((tweet) => !tweet.isReply));
        assert.ok(defaults.tweets.some((tweet) => tweet.isRetweet));
        const reply = success(await userTweets(client, '@rsshub_test', { includeReplies: true, includeRetweets: false, limit: 5 }));
        assert.equal(upstream.log().at(-1).operation, 'UserTweetsAndReplies');
        assert.ok(reply.tweets.some((tweet) => tweet.isReply));
        assert.ok(reply.tweets.every((tweet) => !tweet.isRetweet));
        success(await userTweets(client, '+900000000000000002'));
        assert.ok(upstream.log().some((request) => request.operation === 'UserByRestId'));
    });
    await step(`${prefix}J5`, 'third-party-only detail rejects without X; unknown account is invalid_parameter', async () => {
        const before = upstream.hits();
        failure(await client.callTool({ name: 'twitter_get_tweet', arguments: { user: 'rsshub_test', tweetId: '123' } }), 'source_config_missing');
        assert.equal(upstream.hits(), before);
        failure(await userTweets(client, 'missing'), 'invalid_parameter');
    });
}
async function paging(client, prefix) {
    await step(`${prefix}J10`, 'search/user cursor walks without loss; malformed/mismatched denied; unsigned edits forwarded', async () => {
        let first;
        for (const kind of ['search', 'user']) {
            let cursor;
            const ids = [];
            for (let page = 0; page < 12; page++) {
                const args = { limit: 5, ...(cursor && { cursor }) };
                const result = success(await (kind === 'search' ? search(client, 'cursor-walk', args) : userTweets(client, 'rsshub_test', { ...args, includeReplies: true })));
                ids.push(...result.tweets.map((tweet) => tweet.id));
                cursor = result.nextCursor;
                if (kind === 'search') {
                    first ||= cursor;
                }
                if (!cursor) {
                    break;
                }
            }
            assert.equal(cursor, undefined);
            assert.equal(ids.length, 23);
            assert.equal(new Set(ids).size, 23);
        }
        const before = upstream.hits();
        failure(await userTweets(client, 'rsshub_test', { cursor: first }), 'invalid_cursor');
        failure(await search(client, 'different', { cursor: first }), 'invalid_cursor');
        for (const shape of [{}, { t: 'twitter_search', b: 'web', k: 'bad' }, { t: 'twitter_search', b: 'web', k: '0123456789abcdef', c: 12 }]) {
            const cursor = `v1.${Buffer.from(JSON.stringify(shape)).toString('base64url')}`;
            failure(await search(client, 'cursor-walk', { cursor }), 'invalid_cursor');
        }
        failure(await search(client, 'cursor-walk', { cursor: 'v1.bm90LWpzb24' }), 'invalid_cursor');
        assert.equal(upstream.hits(), before);
        const edited = JSON.parse(Buffer.from(first.slice(3), 'base64url').toString());
        edited.c = 'edited-upstream';
        delete edited.a;
        const editedCursor = `v1.${Buffer.from(JSON.stringify(edited)).toString('base64url')}`;
        const result = success(await search(client, 'cursor-walk', { cursor: editedCursor }));
        assert.equal(upstream.log().at(-1).variables.cursor, 'edited-upstream');
        assert.equal(result.nextCursor, undefined);
        assert.deepEqual(result.tweets, []);
    });
}
try {
    await checkpoint();
    await start(false, { MCP_ENABLE: 'false' }, 'disabled');
    const disabled = await feedSnapshot();
    await start();
    let client;
    await step('J1', 'real SDK discovery in legacy SSE and modern JSON without MCP authentication', async () => {
        client = await discovery('dev');
    });
    await basics(client, '');
    await step('J4', 'fresh repeated reads, retained user lookup, RSS cache isolation and independent held requests both directions', async () => {
        let before = upstream.hits('UserTweets');
        success(await userTweets(client));
        success(await userTweets(client));
        assert.equal(upstream.hits('UserTweets'), before + 2);
        const rssPath = `${base}/twitter/user/rsshub_test?key=${accessKey}`;
        assert.equal((await capture(rssPath)).status, 200);
        before = upstream.hits('UserTweets');
        success(await userTweets(client));
        assert.equal(upstream.hits('UserTweets'), before + 1);
        assert.equal((await capture(rssPath)).headers.get('RSSHub-Cache-Status'), 'HIT');
        assert.equal(upstream.hits('UserTweets'), before + 1);
        const query = 'independent-rss';
        upstream.hold(query, true);
        const rss = capture(`${base}/twitter/keyword/${query}?key=${accessKey}`);
        await upstream.waitFor(query);
        success(await search(client, query));
        upstream.release(query);
        assert.equal((await rss).status, 200);
        upstream.hold('independent-mcp', true);
        const mcp = search(client, 'independent-mcp');
        await upstream.waitFor('independent-mcp');
        assert.equal((await capture(`${base}/twitter/keyword/independent-mcp?key=${accessKey}`)).status, 200);
        upstream.release('independent-mcp');
        success(await mcp);
        assert.equal(upstream.log().filter((request) => request.operation === 'UserByScreenName' && request.variables.screen_name === 'rsshub_test').length, 1);
    });
    await step('J6', 'real rate limits/errors, capacity, deadlines, cancellation, schema/Origin/405/body-limit and removed tools', async () => {
        upstream.fail('rate-limit', 429);
        assert.equal(failure(await search(client, 'rate-limit'), 'upstream_rate_limited').retryAfterSeconds, 120);
        upstream.fail('upstream-error', 500);
        failure(await search(client, 'upstream-error'), 'upstream_error');
        upstream.hold('running');
        const running = search(client, 'running');
        await upstream.waitFor('running');
        const queued = search(client, 'queued-timeout');
        await delay();
        failure(await search(client, 'capacity'), 'capacity_exceeded');
        assert.equal(failure(await running, 'timeout').phase, 'running');
        assert.equal(failure(await queued, 'timeout').phase, 'queued');
        assert.equal(upstream.hits('queued-timeout'), 0);
        const next = search(client, 'after-timeout');
        await delay();
        assert.equal(upstream.hits('after-timeout'), 0);
        upstream.release('running');
        success(await next);
        upstream.hold('cancel-running');
        const activeController = new AbortController();
        const active = expectAbort(rawSearch('cancel-running', activeController.signal));
        await upstream.waitFor('cancel-running');
        const queuedController = new AbortController();
        const cancelled = expectAbort(rawSearch('cancel-queued', queuedController.signal));
        await delay();
        queuedController.abort();
        await cancelled;
        activeController.abort();
        await active;
        const recovery = search(client, 'after-cancel');
        await delay();
        assert.equal(upstream.hits('after-cancel'), 0);
        upstream.release('cancel-running');
        success(await recovery);
        assert.equal(upstream.hits('cancel-queued'), 0);
        const invalid = await search(client, '', { limit: 0 });
        assert.equal(invalid.isError, true);
        assert.match(invalid.content[0].text, /^Input validation error/);
        assert.equal(invalid.structuredContent, undefined);
        for (const name of ['fetch_feed', 'search_routes']) {
            await assert.rejects(client.callTool({ name, arguments: {} }), /not found/);
        }
        assert.equal((await capture(`${base}/mcp`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
        for (const method of ['GET', 'DELETE']) {
            assert.equal((await capture(`${base}/mcp`, { method })).status, 405);
        }
        assert.equal((await capture(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: ' '.repeat(65537) })).status, 413);
    });
    await paging(client, '');
    await step('J8', 'RSS/JSON and ETags byte-identical with MCP disabled/enabled, including Twitter and user routes', async () => {
        assert.deepEqual(await feedSnapshot(), disabled);
    });
    await start(false, { MCP_TOOLS: 'twitter_search' }, 'subset');
    await step('J7', 'restart exposes only MCP_TOOLS subset', async () => {
        const subset = await connect();
        assert.deepEqual(
            (await subset.listTools()).tools.map((tool) => tool.name),
            ['twitter_search']
        );
    });
    if (process.argv.includes('--skip-production')) {
        report.steps.push({ id: 'J9', passed: false, status: 'unrun', actual: '--skip-production cannot pass acceptance' });
    } else {
        const bundle = path.join(root, 'dist/index.mjs');
        const bytes = await readFile(bundle);
        const digest = createHash('sha256').update(bytes).digest('hex');
        await start(true);
        await step('J9/J1', 'production bundle real discovery both eras', async () => {
            client = await discovery('production');
        });
        await basics(client, 'J9/');
        await paging(client, 'J9/');
        await step('J9/J8', 'production feeds/ETags match disabled dev with identical fixture clock', async () => {
            assert.deepEqual(await feedSnapshot(), disabled);
        });
        const after = await readFile(bundle);
        assert.equal(createHash('sha256').update(after).digest('hex'), digest);
        await writeFile(path.join(evidence, 'dist-sha256.txt'), digest + '\n');
    }
    report.passed = report.steps.every((entry) => entry.passed);
} catch (error) {
    report.error = error.stack || String(error);
    process.stderr.write(`${report.error}\n`);
} finally {
    clearTimeout(watchdog);
    interrupted.abort();
    await stop();
    await upstream.close();
    report.outbound = (await readFile(outboundPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    if (report.outbound.every((entry) => entry.event !== 'installed') || report.outbound.every((entry) => entry.event !== 'connected') || report.outbound.some((entry) => entry.event === 'violation')) {
        report.passed = false;
    }
    for (const host of ['x.com', 'cdn.jsdelivr.net']) {
        if (report.outbound.every((entry) => entry.event !== 'blocked' || entry.host !== host)) {
            report.passed = false;
        }
    }
    await writeFile(path.join(evidence, 'upstream-log.json'), JSON.stringify(upstream.log(), null, 2) + '\n');
    await writeFile(path.join(evidence, 'transcript.jsonl'), transcript.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await rm(scratch, { recursive: true, force: true });
    report.cleanup = 'clients closed; server reaped; fixture closed; own scratch removed';
    report.finishedAt = new Date().toISOString();
    await checkpoint();
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    process.stdout.write(`${report.passed ? 'PASS' : 'FAIL'}: ${evidence}\n`);
    if (!report.passed) {
        process.exitCode = 1;
    }
}
