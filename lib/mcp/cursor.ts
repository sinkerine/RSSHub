/* oxlint-disable regexp/prefer-d, regexp/prefer-w, regexp/use-ignore-case -- Preserve the approved public schema patterns. */
import { createHash } from 'node:crypto';

import { z } from 'zod';

export type PagedTool = 'twitter_search' | 'twitter_user_tweets';
export type TwitterBackend = 'web' | 'developer';
const cursorSchema = z.strictObject({
    t: z.enum(['twitter_search', 'twitter_user_tweets']),
    b: z.enum(['web', 'developer']),
    k: z.string().regex(/^[a-f0-9]{16}$/),
    c: z.string().min(1).optional(),
    a: z
        .string()
        .regex(/^[0-9]{1,20}$/)
        .optional(),
});
export type Cursor = z.infer<typeof cursorSchema>;
export interface CursorBinding {
    t: PagedTool;
    b: TwitterBackend;
    k: string;
}
export class InvalidCursorError extends Error {
    override name = 'InvalidCursorError';
    constructor() {
        super('This cursor is malformed or does not belong to this query or backend; call again without cursor.');
    }
}
export function cursorBinding(t: PagedTool, b: TwitterBackend, arguments_: { query: string } | { user: string; includeReplies: boolean }): CursorBinding {
    const canonical = 'query' in arguments_ ? { query: arguments_.query } : { user: arguments_.user.replace(/^@/, '').toLowerCase(), includeReplies: arguments_.includeReplies };
    return { t, b, k: createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16) };
}
export function encodeCursor(cursor: Cursor): string {
    return `v1.${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
}
export function decodeCursor(token: string | undefined, binding: CursorBinding): Cursor | undefined {
    if (token === undefined) {
        return;
    }
    try {
        if (!/^v1\.[A-Za-z0-9_-]+$/.test(token) || token.length > 4096) {
            throw new Error('format');
        }
        const bytes = Buffer.from(token.slice(3), 'base64url');
        if (bytes.toString('base64url') !== token.slice(3)) {
            throw new Error('base64url');
        }
        const value = cursorSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (value.t !== binding.t || value.b !== binding.b || value.k !== binding.k) {
            throw new Error('binding');
        }
        return value;
    } catch {
        throw new InvalidCursorError();
    }
}
export function resumePage<T extends { id_str: string }>(tweets: T[], cursor?: Cursor): T[] {
    const index = cursor?.a ? tweets.findIndex((tweet) => tweet.id_str === cursor.a) : -1;
    return tweets.slice(index + 1);
}
export function nextCursor(binding: CursorBinding, cursor: Cursor | undefined, sourceCount: number, remaining: number, returned: Array<{ id_str: string }>, upstream?: string): string | undefined {
    if (remaining > returned.length && returned.length) {
        return encodeCursor({ ...binding, ...(cursor?.c && { c: cursor.c }), a: returned.at(-1)!.id_str });
    }
    if (sourceCount && upstream && upstream !== cursor?.c) {
        return encodeCursor({ ...binding, c: upstream });
    }
}
