import { describe, expect, it } from 'vitest';

import { resolveAllowlist } from './allowlist';
import { searchAllowedRoutes } from './catalog';

const allowed = resolveAllowlist(['/fixture/:id/:tail?', '/fixture/other'], {
    fixture: {
        name: 'Fixture',
        routes: {
            '/:id/:tail?': {
                path: '/:id/:tail?',
                location: 'one.ts',
                name: 'News',
                description: 'x'.repeat(800),
                example: '/fixture/a',
                parameters: { id: 'Required id', tail: { description: 'Tail', default: 'a', options: [{ value: 'a', label: 'A' }] } },
                features: { requireConfig: [{ name: 'PRIVATE_TOKEN', optional: true }] },
            },
            '/other': { path: '/other', location: 'two.ts', name: 'Other' },
        } as never,
        apiRoutes: {},
    },
});
describe('search allowed routes', () => {
    it('maps metadata, clips descriptions and excludes config values', () => {
        const result = searchAllowedRoutes(allowed, { query: 'news' });
        expect(result.total).toBe(1);
        expect(result.routes[0]).toMatchObject({
            path: '/fixture/:id/:tail?',
            namespaceName: 'Fixture',
            parameters: [
                { name: 'id', optional: false, description: 'Required id' },
                { name: 'tail', optional: true, default: 'a', options: ['a'] },
            ],
            requiresConfig: [{ name: 'PRIVATE_TOKEN', optional: true }],
        });
        expect(result.routes[0].description!.length).toBeLessThanOrEqual(500);
    });
    it('searches root metadata by the existing catalog identity and emits the canonical fetch path', () => {
        const root = resolveAllowlist(['/fixture/'], { fixture: { name: 'Fixture', routes: { '/': { path: '/', name: 'Canonical root', location: 'root.ts' } } as never, apiRoutes: {} } });
        expect(searchAllowedRoutes(root, { query: 'canonical' }).routes.map((entry) => entry.path)).toEqual(['/fixture']);
        expect(searchAllowedRoutes(root, {}).routes.map((entry) => entry.path)).toEqual(['/fixture']);
    });
    it('clips descriptions without splitting a surrogate pair at 500 UTF-16 units', () => {
        const boundary = { ...allowed, routes: allowed.routes.map((entry) => ({ ...entry, route: { ...entry.route, description: 'a'.repeat(499) + '🔥' } })) };
        const description = searchAllowedRoutes(boundary, {}).routes[0].description!;
        expect(description.length).toBeLessThanOrEqual(500);
        expect(description.isWellFormed()).toBe(true);
        const serialized = JSON.stringify({ description });
        expect(JSON.parse(serialized).description.isWellFormed()).toBe(true);
    });
    it('sorts empty queries and paginates without a next offset on final page', () => {
        const first = searchAllowedRoutes(allowed, { limit: 1 });
        expect(first).toMatchObject({ total: 2, nextOffset: 1 });
        const last = searchAllowedRoutes(allowed, { limit: 1, offset: 1 });
        expect(last.nextOffset).toBeUndefined();
        expect(searchAllowedRoutes(allowed, { offset: 100 }).routes).toEqual([]);
    });
});
