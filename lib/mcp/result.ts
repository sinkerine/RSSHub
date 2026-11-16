import { z } from 'zod';

import { htmlToText } from '@/magpie/feed';

import type { AllowedRoute } from './allowlist';
import type { SearchResult } from './catalog';
import type { DispatchOutcome } from './dispatch';
import { clipText } from './text';

export const MCP_ITEM_CONTENT_MAX_CHARS = 4000;
const feedItemSchema = z.object({
    title: z.string().optional(),
    link: z.string().optional(),
    guid: z.string().optional(),
    pubDate: z.string().optional(),
    updated: z.string().optional(),
    author: z.string().optional(),
    categories: z.array(z.string()).optional(),
    content: z.string().optional(),
    contentFormat: z.enum(['text', 'html', 'none']),
    contentTruncated: z.boolean(),
    image: z.string().optional(),
    enclosure: z.object({ url: z.string(), type: z.string().optional(), length: z.number().optional() }).optional(),
});
const outputSchema = z.object({
    route: z.object({ path: z.string(), namespace: z.string(), name: z.string() }),
    requestPath: z.string(),
    feed: z.object({ title: z.string(), link: z.string().optional(), description: z.string().optional(), image: z.string().optional(), language: z.string().optional(), author: z.string().optional() }),
    items: z.array(feedItemSchema),
    itemCount: z.number().int().nonnegative(),
    returnedCount: z.number().int().nonnegative(),
    truncation: z.object({ items: z.boolean(), content: z.boolean(), bytes: z.boolean() }),
    snapshot: z.object({ cache: z.enum(['hit', 'miss', 'disabled']), builtAt: z.string(), ttlMinutes: z.number(), pagination: z.literal('none') }),
});
export type FetchFeedOutput = z.infer<typeof outputSchema>;
export const fetchFeedOutputSchema: z.ZodType<FetchFeedOutput> = outputSchema;
const parameterSchema = z.object({ name: z.string(), optional: z.boolean(), description: z.string().optional(), default: z.string().optional(), options: z.array(z.string()).optional() });
const requireConfigSchema = z.object({ name: z.string(), optional: z.boolean() });
const routeSummarySchema = z.object({
    path: z.string(),
    namespace: z.string(),
    namespaceName: z.string(),
    name: z.string(),
    example: z.string().optional(),
    description: z.string().optional(),
    parameters: z.array(parameterSchema),
    requiresConfig: z.array(requireConfigSchema),
});
export const searchRoutesOutputSchema: z.ZodType<SearchResult> = z.object({ routes: z.array(routeSummarySchema), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().optional() });
export interface FeedResultOptions {
    limit: number;
    content: 'text' | 'html' | 'none';
    maxResponseBytes: number;
    cacheAvailable: boolean;
}
const string = (value: unknown) => (typeof value === 'string' ? value : undefined);
function date(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        return;
    }
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
        return parsed.toISOString();
    }
}
function mapItem(value: unknown, mode: FeedResultOptions['content']): z.infer<typeof feedItemSchema> {
    const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const description = string(item.description) || '';
    const content = mode === 'none' ? undefined : mode === 'text' ? htmlToText(description) : description;
    const author = Array.isArray(item.author)
        ? item.author
              .map((entry) => string(entry?.name))
              .filter(Boolean)
              .join(', ')
        : string(item.author);
    return {
        ...Object.fromEntries(['title', 'link', 'image'].filter((key) => typeof item[key] === 'string').map((key) => [key, item[key]])),
        ...(string(item.guid ?? item.link) !== undefined && { guid: string(item.guid ?? item.link) }),
        ...(date(item.pubDate) && { pubDate: date(item.pubDate) }),
        ...(date(item.updated) && { updated: date(item.updated) }),
        ...(author && { author }),
        ...(item.category !== undefined && item.category !== null && { categories: Array.isArray(item.category) ? item.category.filter((entry): entry is string => typeof entry === 'string') : [String(item.category)] }),
        ...(content !== undefined && { content: clipText(content, MCP_ITEM_CONTENT_MAX_CHARS) }),
        contentFormat: mode,
        contentTruncated: content !== undefined && content.length > MCP_ITEM_CONTENT_MAX_CHARS,
        ...(typeof item.enclosure_url === 'string' && {
            enclosure: {
                url: item.enclosure_url,
                ...(typeof item.enclosure_type === 'string' && { type: item.enclosure_type }),
                ...(typeof item.enclosure_length === 'number' && Number.isFinite(item.enclosure_length) && { length: item.enclosure_length }),
            },
        }),
    };
}

export function buildFeedResult(route: AllowedRoute, requestPath: string, outcome: Extract<DispatchOutcome, { kind: 'data' }>, options: FeedResultOptions): FetchFeedOutput {
    const { data } = outcome;
    const items = data.item.slice(0, options.limit).map((item) => mapItem(item, options.content));
    const output: FetchFeedOutput = {
        route: { path: route.pattern, namespace: route.namespace, name: route.route.name },
        requestPath,
        feed: { title: string(data.title) || '', ...Object.fromEntries(['link', 'description', 'image', 'language', 'author'].filter((key) => typeof data[key] === 'string').map((key) => [key, data[key]])) },
        items,
        itemCount: data.item.length,
        returnedCount: items.length,
        truncation: { items: items.length < data.item.length, content: items.some((item) => item.contentTruncated), bytes: false },
        snapshot: {
            cache: outcome.cacheHit ? 'hit' : options.cacheAvailable ? 'miss' : 'disabled',
            builtAt: options.cacheAvailable ? date(data.lastBuildDate) || outcome.completedAt.toISOString() : outcome.completedAt.toISOString(),
            ttlMinutes: typeof data.ttl === 'number' ? data.ttl : 1,
            pagination: 'none',
        },
    };
    while (Buffer.byteLength(JSON.stringify(output), 'utf8') > options.maxResponseBytes && output.items.length) {
        output.items.pop();
        output.returnedCount = output.items.length;
        output.truncation.bytes = true;
        output.truncation.content = output.items.some((item) => item.contentTruncated);
    }
    // Metadata alone can exceed the bound; fail explicitly rather than returning an oversized success.
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > options.maxResponseBytes) {
        throw new Error('Feed metadata exceeds MCP_MAX_RESPONSE_BYTES');
    }
    return output;
}
