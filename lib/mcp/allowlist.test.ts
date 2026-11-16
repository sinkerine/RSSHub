import fs from 'node:fs/promises';

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { NamespacesType } from '@/registry-helpers';
import { registerRssRoutes } from '@/registry-helpers';
import logger from '@/utils/logger';

import { createAllowlistProvider, resolveAllowlist, validateFeedPath } from './allowlist';

const route = (name: string) => ({ name, path: '/:id', location: 'fixture.ts', maintainers: [], example: '/fixture/1', handler: vi.fn() });
describe('allowlist', () => {
    it.each(['', 'abc', '//a', '/x?format=json', '/x#frag', '/a b', '/a/../api', '/a/%2e%2e/api', String.raw`/a\..\api`, '/' + 'a'.repeat(2048)])('rejects invalid syntax %s', (input) =>
        expect(validateFeedPath(input).ok).toBe(false)
    );
    it('accepts encoded parameters without normalization', () => expect(validateFeedPath('/twitter/user/a%20b')).toEqual({ ok: true, path: '/twitter/user/a%20b' }));
    it('matches the first route in RSSHub order, including overlapping and nested namespaces', () => {
        const namespaces = {
            fixture: { name: 'Fixture', routes: { '/:id': route('param'), '/literal': route('literal'), '/:id/:tail?': route('optional') }, apiRoutes: {} },
            'fixture/nested': { name: 'Nested', routes: { '/:id': route('nested') }, apiRoutes: {} },
        } as NamespacesType;
        const allowed = resolveAllowlist(['/fixture/:id', '/fixture/:id/:tail?'], namespaces);
        expect(allowed.match('/fixture/literal')).toBeUndefined();
        expect(allowed.match('/fixture/nested/a')).toBeUndefined();
        expect(allowed.match('/fixture/a')?.route.name).toBe('param');
        for (const reserved of ['/', '/mcp', '/api/namespace', '/healthz', '/metrics', '/robots.txt']) {
            expect(allowed.match(reserved)).toBeUndefined();
        }
    });
    it.each(['fixture', 'fixture/nested'])('rejects excluded %s root with an allowed optional overlap using real Hono registration', async (namespace) => {
        const root = vi.fn(() => Response.json({ title: 'excluded root' }));
        const optional = vi.fn(() => Response.json({ title: 'allowed optional' }));
        const namespaces = {
            [namespace]: {
                name: 'Fixture',
                routes: {
                    '/': { ...route('Root'), path: '/', handler: root },
                    '/:id?': { ...route('Optional'), path: '/:id?', handler: optional },
                },
                apiRoutes: {},
            },
        } as NamespacesType;
        const app = new Hono();
        registerRssRoutes(app, namespaces);
        expect(await (await app.request(`/${namespace}`)).json()).toMatchObject({ title: 'excluded root' });
        expect(root).toHaveBeenCalledTimes(1);
        expect(optional).not.toHaveBeenCalled();
        root.mockClear();
        const allowed = resolveAllowlist([`/${namespace}/:id?`], namespaces);
        const admitted = allowed.match(`/${namespace}`);
        if (admitted) {
            await app.request(`/${namespace}`);
        }
        expect(root).not.toHaveBeenCalled();
        expect(allowed.match(`/${namespace}`)).toBeUndefined();
        expect(allowed.match(`/${namespace}/value`)?.route.name).toBe('Optional');
    });
    it.each(['fixture', 'fixture/nested'])('canonicalizes configured %s root aliases and deduplicates route identity', (namespace) => {
        const namespaces = { [namespace]: { name: 'Fixture', routes: { '/': { ...route('Root'), path: '/' } }, apiRoutes: {} } } as NamespacesType;
        for (const patterns of [[`/${namespace}`], [`/${namespace}/`], [`/${namespace}/`, `/${namespace}`, `/${namespace}/`]]) {
            const allowed = resolveAllowlist(patterns, namespaces);
            expect(allowed.unresolved).toEqual([]);
            expect(allowed.routes.map((entry) => entry.pattern)).toEqual([`/${namespace}`]);
            expect(allowed.match(`/${namespace}`)?.route.name).toBe('Root');
        }
    });
    it('resolves real routes.json and routes.js metadata without loading handlers', async () => {
        const json = JSON.parse(await fs.readFile(new URL('../../assets/build/routes.json', import.meta.url), 'utf8'));
        const production = (await import('../../assets/build/routes.js')).default;
        const patterns = ['/twitter/user/:id/:routeParams?', '/twitter/trends/:woeid?', '/missing/nope'];
        for (const registry of [json, production]) {
            const allowed = resolveAllowlist(patterns, registry);
            expect(allowed.routes.map((r) => r.pattern)).toEqual(patterns.slice(0, 2));
            expect(allowed.unresolved).toEqual(['/missing/nope']);
            expect(allowed.match('/twitter/user/_RSSHub')?.namespace).toBe('twitter');
            expect(allowed.match('/twitter/spaces/user')).toBeUndefined();
        }
    });
    it('memoizes success and retries after failure with one warning for each distinct unresolved pattern', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
        const load = vi.fn().mockRejectedValueOnce(new Error('load failed')).mockResolvedValue({});
        const provider = createAllowlistProvider({ patterns: ['/missing/path', '/missing/other', '/missing/path'], loadNamespaces: load });
        try {
            await expect(provider()).rejects.toThrow('load failed');
            expect(warn).not.toHaveBeenCalled();
            const result = await provider();
            expect(result.unresolved).toEqual(['/missing/path', '/missing/other']);
            expect(await provider()).toBe(result);
            expect(await provider()).toBe(result);
            expect(load).toHaveBeenCalledTimes(2);
            expect(warn).toHaveBeenCalledTimes(2);
            expect(warn).toHaveBeenNthCalledWith(1, 'MCP route not found in registry: /missing/path');
            expect(warn).toHaveBeenNthCalledWith(2, 'MCP route not found in registry: /missing/other');
        } finally {
            warn.mockRestore();
        }
    });
    it('no browser imports in MCP source', async () => {
        const directory = new URL('./', import.meta.url);
        const names = (await fs.readdir(directory)).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));
        await Promise.all(
            names.map(async (name) => {
                const source = await fs.readFile(new URL(name, directory), 'utf8');
                const imports = source
                    .matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)
                    .toArray()
                    .map((match) => match[2]);
                expect(
                    imports.filter((s) => /utils\/playwright|patchright|puppeteer/.test(s)),
                    name
                ).toEqual([]);
            })
        );
    });
});
