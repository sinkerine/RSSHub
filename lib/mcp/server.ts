import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { Config } from '@/config';

import type { Allowlist } from './allowlist';
import { validateFeedPath } from './allowlist';
import { searchAllowedRoutes } from './catalog';
import type { FeedDispatcher } from './dispatch';
import type { McpErrorCode, McpToolError } from './errors';
import { classifyError, errorForCode, toolError } from './errors';
import type { Limiter } from './limiter';
import { CapacityError, LimiterAbortError } from './limiter';
import { buildFeedResult, fetchFeedOutputSchema, searchRoutesOutputSchema } from './result';

export interface ToolDeps {
    mcpConfig: Config['mcp'];
    allowlist: () => Promise<Allowlist>;
    limiter: Limiter;
    dispatcher: FeedDispatcher;
    redact: (text: string) => string;
    cacheAvailable: () => boolean;
    log: (line: string) => void;
}
function success(structuredContent: Record<string, unknown>): CallToolResult {
    return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
}

function redactValue<T>(value: T, redact: (text: string) => string): T {
    if (typeof value === 'string') {
        return redact(value) as T;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactValue(entry, redact)) as T;
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, redact)])) as T;
    }
    return value;
}

export function buildMcpServer(deps: ToolDeps, request?: Request): McpServer {
    const server = new McpServer({ name: 'rsshub', version: '1.0.0' });
    server.registerTool(
        'search_routes',
        {
            description: 'Discover allowlisted feed routes. Use a returned pattern and its parameters to construct fetch_feed paths.',
            inputSchema: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).optional() }),
            outputSchema: searchRoutesOutputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (input) => {
            const started = performance.now();
            let status: McpErrorCode | 'ok' = 'ok';
            try {
                const result = searchAllowedRoutes(await deps.allowlist(), input);
                return success({ ...redactValue(result, deps.redact) });
            } catch {
                status = 'internal_error';
                return toolError(errorForCode(status));
            } finally {
                deps.log(`mcp search_routes - ${status} ${Math.round(performance.now() - started)}ms`);
            }
        }
    );
    server.registerTool(
        'fetch_feed',
        {
            description: 'Fetch an allowlisted feed snapshot through RSSHub. Path must come from search_routes. Results are bounded snapshots with no pagination.',
            inputSchema: z.object({ path: z.string().min(1).max(2048), limit: z.number().int().min(1).max(deps.mcpConfig.maxItems).optional(), content: z.enum(['text', 'html', 'none']).optional() }),
            outputSchema: fetchFeedOutputSchema,
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ path, limit = Math.min(20, deps.mcpConfig.maxItems), content = 'text' }, ctx) => {
            const started = performance.now();
            const deadline = AbortSignal.timeout(deps.mcpConfig.timeout * 1000);
            let status: McpErrorCode | 'ok' = 'ok';
            let pattern = '-';
            const failure = (error: McpToolError) => {
                status = error.code;
                return toolError({ ...error, message: deps.redact(error.message) });
            };
            try {
                if (!validateFeedPath(path).ok) {
                    return failure(errorForCode('invalid_arguments'));
                }
                const route = (await deps.allowlist()).match(path);
                if (!route) {
                    return failure(errorForCode('route_not_allowed'));
                }
                pattern = route.pattern;
                const signal = AbortSignal.any([ctx.mcpReq.signal, ...(request ? [request.signal] : []), deadline]);
                const outcome = await deps.limiter.run(() => deps.dispatcher.dispatch(path), signal);
                if (outcome.kind === 'error') {
                    return failure(classifyError(outcome.error));
                }
                if (outcome.kind === 'unsupported') {
                    return failure(errorForCode('unsupported_result'));
                }
                const output = buildFeedResult(route, path, outcome, { limit, content, maxResponseBytes: deps.mcpConfig.maxResponseBytes, cacheAvailable: deps.cacheAvailable() });
                return success(output);
            } catch (error) {
                if (error instanceof CapacityError) {
                    return failure(errorForCode('capacity_exceeded'));
                }
                if (error instanceof LimiterAbortError) {
                    if (deadline.aborted) {
                        return failure(errorForCode('timeout', error.phase));
                    }
                    status = 'internal_error';
                    throw error;
                }
                return failure(errorForCode('internal_error'));
            } finally {
                deps.log(`mcp fetch_feed ${pattern} ${status} ${Math.round(performance.now() - started)}ms`);
            }
        }
    );
    return server;
}
