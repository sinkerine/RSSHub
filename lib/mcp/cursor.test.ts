import { describe, expect, it } from 'vitest';

import { cursorBinding, decodeCursor, encodeCursor, nextCursor, resumePage } from './cursor';

const binding = cursorBinding('twitter_search', 'web', { query: '"quoted" #tag % / ? 中文' });
const token = (value: unknown) => `v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
describe('unsigned Twitter cursors', () => {
    it('round trips and binds exact query, tool, backend and canonical user/replies', () => {
        const value = { ...binding, c: 'upstream', a: '123' };
        expect(decodeCursor(encodeCursor(value), binding)).toEqual(value);
        expect(cursorBinding('twitter_user_tweets', 'web', { user: '@DIYgod', includeReplies: false })).toEqual(cursorBinding('twitter_user_tweets', 'web', { user: 'diygod', includeReplies: false }));
        for (const changed of [
            { ...binding, t: 'twitter_user_tweets' as const },
            { ...binding, b: 'developer' as const },
            { ...binding, k: '0000000000000000' },
        ]) {
            expect(() => decodeCursor(encodeCursor(value), changed)).toThrow(/does not belong/);
        }
        expect(cursorBinding('twitter_search', 'web', { query: 'different' }).k).not.toBe(binding.k);
        expect(cursorBinding('twitter_user_tweets', 'web', { user: 'user', includeReplies: true }).k).not.toBe(cursorBinding('twitter_user_tweets', 'web', { user: 'user', includeReplies: false }).k);
    });
    it.each([null, [], {}, { ...binding, unknown: true }, { ...binding, c: '' }, { ...binding, c: 12 }, { ...binding, a: 'abc' }, { ...binding, a: '' }, { ...binding, b: 'unknown' }, { ...binding, k: 'ABC' }])(
        'rejects malformed shape %j',
        (value) => {
            expect(() => decodeCursor(token(value), binding)).toThrow(/malformed/);
        }
    );
    it.each(['v2.e30', 'v1.a', 'v1._', 'v1.e30=', 'v1.bm90LWpzb24', ''])('rejects malformed encoding %s', (value) => {
        expect(() => decodeCursor(value, binding)).toThrow(/malformed/);
    });
    it('accepts well-typed edited c/a, because tokens are unsigned', () => {
        const forged = { ...binding, c: 'edited-upstream', a: '999' };
        expect(decodeCursor(token(forged), binding)).toEqual(forged);
    });
    it('resumes after raw upstream id; missing id resumes from page start', () => {
        const page = [{ id_str: '3' }, { id_str: '2' }, { id_str: '1' }];
        expect(resumePage(page, { ...binding, a: '2' })).toEqual([{ id_str: '1' }]);
        expect(resumePage(page, { ...binding, a: '999' })).toEqual(page);
    });
    it('walks within-page then upstream page, ending on empty or repeated upstream cursor', () => {
        const selected = [{ id_str: '3' }, { id_str: '2' }];
        expect(decodeCursor(nextCursor(binding, undefined, 3, 3, selected, 'page-2')!, binding)).toEqual({ ...binding, a: '2' });
        expect(decodeCursor(nextCursor(binding, undefined, 3, 2, selected, 'page-2')!, binding)).toEqual({ ...binding, c: 'page-2' });
        expect(nextCursor(binding, { ...binding, c: 'page-2' }, 3, 2, selected, 'page-2')).toBeUndefined();
        expect(nextCursor(binding, undefined, 0, 0, [], 'endless')).toBeUndefined();
        expect(nextCursor(binding, undefined, 3, 2, selected)).toBeUndefined();
        expect(decodeCursor(nextCursor(binding, undefined, 3, 0, [], 'page-2')!, binding)).toEqual({ ...binding, c: 'page-2' });
    });
});
