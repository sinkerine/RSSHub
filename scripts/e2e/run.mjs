import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'patchright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workspaceKey = createHash('sha256').update(root.replace(/\/$/, '')).digest('hex').slice(0, 16);
const scratchRoot = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'dev-scratch/rsshub', workspaceKey, 'e2e');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(path.join(scratchRoot, 'run-'));
// Chromium's singleton socket needs a short path; the browser profile stays in scratch.
const socketDirectory = await mkdtemp(path.join(tmpdir(), 'rsshub-'));
process.env.TMPDIR = scratch;
const evidence = path.join(root, 'assets/build/e2e', path.basename(scratch));
await mkdir(evidence, { recursive: true });
const log = createWriteStream(path.join(evidence, 'server.log'));
const report = { host: hostname(), startedAt: new Date().toISOString(), passed: false, checks: [] };
let child;
let browser;
let exited;

function interrupt() {
    child?.kill('SIGTERM');
    void browser?.close();
    process.exitCode = 1;
}
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

try {
    assert.ok(process.env.CHROMIUM_EXECUTABLE_PATH, 'Enter the Nix shell to set CHROMIUM_EXECUTABLE_PATH.');
    const routes = path.join(scratch, 'routes');
    await mkdir(routes);
    await copyFile(new URL('fixtures/e2e-smoke.mjs', import.meta.url), path.join(routes, 'e2e-smoke.mjs'));
    // Only pass host/tooling variables: personal .env settings must not alter the test server.
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TZ', 'SSL_CERT_FILE', 'NIX_SSL_CERT_FILE', 'CHROMIUM_EXECUTABLE_PATH'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    child = fork(fileURLToPath(new URL('server.ts', import.meta.url)), [], {
        cwd: root,
        execArgv: ['--import', 'tsx'],
        env: {
            ...env,
            NODE_ENV: 'dev',
            NODE_OPTIONS: '--max-http-header-size=32768',
            DOTENV_CONFIG_PATH: path.join(scratch, 'absent.env'),
            PORT: '0',
            LISTEN_INADDR_ANY: 'false',
            ENABLE_CLUSTER: 'false',
            CACHE_TYPE: 'memory',
            USER_ROUTES_PATH: routes,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    exited = new Promise((resolve) => child.once('close', resolve));
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('RSSHub startup exceeded 60 seconds; inspect server.log.')), 60000);
        const cleanup = () => clearTimeout(timer);
        child.once('message', (message) => {
            cleanup();
            resolve(message.port);
        });
        child.once('error', (error) => {
            cleanup();
            reject(error);
        });
        child.once('exit', (code, signal) => {
            cleanup();
            reject(new Error(`RSSHub exited before startup: ${code ?? signal}`));
        });
    });
    assert.ok(Number.isSafeInteger(port) && port > 0);
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(15000) });
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');
    report.checks.push('HTTP health');

    const rss = await fetch(`${base}/e2e-smoke/feed`, { signal: AbortSignal.timeout(15000) });
    assert.equal(rss.status, 200);
    assert.match(rss.headers.get('content-type'), /xml/);
    const xml = await rss.text();
    assert.match(xml, /<rss\b/);
    assert.match(xml, /Smoke test article/);
    await writeFile(path.join(evidence, 'feed.xml'), xml);
    report.checks.push('RSS feed');

    const json = await fetch(`${base}/e2e-smoke/feed?format=json`, { signal: AbortSignal.timeout(15000) });
    assert.equal(json.status, 200);
    const feed = await json.json();
    assert.equal(feed.title, 'RSSHub E2E fixture');
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].url, 'https://example.com/article');
    report.checks.push('JSON Feed');

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, headless: true, env: { ...process.env, TMPDIR: socketDirectory } });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.route('**/*', (route) => (new URL(route.request().url()).origin === base && ['document', 'fetch'].includes(route.request().resourceType()) ? route.continue() : route.abort()));
    const response = await page.goto(`${base}/healthz`);
    assert.equal(response.status(), 200);
    assert.equal(await page.locator('body').textContent(), 'ok');
    const browserFeed = await page.evaluate(async () => {
        const response = await fetch('/e2e-smoke/feed');
        const document = new window.DOMParser().parseFromString(await response.text(), 'application/xml');
        return { status: response.status, title: document.querySelector('item > title')?.textContent, parseError: !!document.querySelector('parsererror') };
    });
    assert.equal(browserFeed.status, 200);
    assert.equal(browserFeed.parseError, false);
    assert.equal(browserFeed.title, 'Smoke test article');
    await page.screenshot({ path: path.join(evidence, 'health.png'), fullPage: true });
    report.checks.push('Headless Chromium health and RSS parsing');
    report.passed = true;
} catch (error) {
    report.error = error.stack || String(error);
    process.stderr.write(`${report.error}\n`);
    process.exitCode = 1;
} finally {
    try {
        await browser?.close();
    } finally {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
            await exited;
            clearTimeout(timer);
        }
        await new Promise((resolve) => log.end(resolve));
        await rm(scratch, { recursive: true, force: true });
        await rm(socketDirectory, { recursive: true, force: true });
        report.finishedAt = new Date().toISOString();
        await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
        process.stdout.write(`${report.passed ? 'PASS' : 'FAIL'}: ${report.checks.join(', ')}\nEvidence: ${evidence}\n`);
    }
}
