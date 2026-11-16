import { describe, expect, it } from 'vitest';

import { resolveAllowlist } from './allowlist';
import { buildFeedResult, fetchFeedOutputSchema } from './result';

const route = resolveAllowlist(['/fixture/feed'], {
    fixture: { name: 'Fixture', routes: { '/feed': { name: 'Feed', path: '/feed', location: 'fixture.ts', maintainers: [], handler: () => ({ title: 'Feed', item: [] }), example: '/fixture/feed' } }, apiRoutes: {} },
}).routes[0];
const outcome = {
    kind: 'data' as const,
    data: {
        title: 'Feed',
        lastBuildDate: 'Wed, 01 Jan 2025 00:00:00 GMT',
        ttl: 5,
        item: Array.from({ length: 30 }, (_, i) => ({
            title: `Item ${i}`,
            link: `https://example.com/${i}`,
            description: '<p>' + '漢字'.repeat(4000) + '</p>',
            pubDate: '2025-01-01',
            category: ['news'],
            enclosure_url: 'https://example.com/audio.mp3',
            enclosure_type: 'audio/mpeg',
            enclosure_length: 100,
            updated: 'bad-date',
        })),
    },
    cacheHit: false,
    completedAt: new Date('2025-02-01'),
};
describe('feed result', () => {
    it.each(['text', 'html', 'none'] as const)('maps %s mode with item/content bounds and typed fields', (content) => {
        const output = buildFeedResult(route, '/fixture/feed', outcome, { limit: 5, content, maxResponseBytes: 262144, cacheAvailable: true });
        expect(fetchFeedOutputSchema.safeParse(output).success).toBe(true);
        expect(output).toMatchObject({
            itemCount: 30,
            returnedCount: 5,
            truncation: { items: true, bytes: false, content: content !== 'none' },
            snapshot: { cache: 'miss', builtAt: '2025-01-01T00:00:00.000Z', ttlMinutes: 5, pagination: 'none' },
        });
        expect(output.items[0]).toMatchObject({
            guid: 'https://example.com/0',
            pubDate: '2025-01-01T00:00:00.000Z',
            categories: ['news'],
            contentFormat: content,
            enclosure: { url: 'https://example.com/audio.mp3', type: 'audio/mpeg', length: 100 },
        });
        expect(output.items[0].updated).toBeUndefined();
        if (content === 'none') {
            expect(output.items[0].content).toBeUndefined();
        } else {
            expect(output.items[0].content!.length).toBeLessThanOrEqual(4000);
        }
        expect(output).not.toHaveProperty('nextOffset');
    });
    it.each(['text', 'html'] as const)('clips %s content without splitting a surrogate pair at 4000 UTF-16 units', (content) => {
        const boundary = { ...outcome, data: { ...outcome.data, item: [{ description: 'a'.repeat(3999) + '🔥' }] } };
        const output = buildFeedResult(route, '/fixture/feed', boundary, { limit: 1, content, maxResponseBytes: 262144, cacheAvailable: true });
        expect(output.items[0].content!.length).toBeLessThanOrEqual(4000);
        expect(output.items[0].content!.isWellFormed()).toBe(true);
        expect(output.items[0].contentTruncated).toBe(true);
        const serialized = JSON.stringify(output);
        expect(serialized).not.toMatch(/\\u[dD][89a-fA-F][\da-fA-F]{2}/);
        expect(JSON.parse(serialized).items[0].content.isWellFormed()).toBe(true);
    });
    it('drops trailing items to meet UTF-8 bytes and distinguishes item-limit truncation', () => {
        const output = buildFeedResult(route, '/fixture/feed', outcome, { limit: 30, content: 'html', maxResponseBytes: 16384, cacheAvailable: true });
        expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16384);
        expect(output.truncation).toMatchObject({ bytes: true, items: false });
        expect(output.returnedCount).toBeLessThan(30);
        expect(output.items.map((i) => i.title)).toEqual(outcome.data.item.slice(0, output.returnedCount).map((i) => i.title));
    });
    it('honors hit build time, disabled completion time and untruncated empty snapshots', () => {
        const hit = buildFeedResult(route, '/fixture/feed', { ...outcome, cacheHit: true }, { limit: 30, content: 'none', maxResponseBytes: 262144, cacheAvailable: true });
        expect(hit.snapshot.cache).toBe('hit');
        expect(hit.truncation).toEqual({ items: false, content: false, bytes: false });
        const disabled = buildFeedResult(route, '/fixture/feed', { ...outcome, data: { item: [], title: 'Empty' } }, { limit: 10, content: 'none', maxResponseBytes: 4096, cacheAvailable: false });
        expect(disabled.snapshot).toMatchObject({ cache: 'disabled', builtAt: outcome.completedAt.toISOString() });
        expect(disabled.returnedCount).toBe(0);
    });
});
