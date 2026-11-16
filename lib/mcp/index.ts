import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Handler } from 'hono';

import type { Config } from '@/config';
import { config } from '@/config';
import { ensureNamespacesLoaded, namespaces } from '@/registry';
import cache from '@/utils/cache';
import type { InternalRequestEnv } from '@/utils/internal-request';
import logger from '@/utils/logger';

import { createAllowlistProvider } from './allowlist';
import { createFeedDispatcher } from './dispatch';
import { createRedactor } from './errors';
import { createLimiter } from './limiter';
import { checkOrigin } from './origin';
import { buildMcpServer } from './server';

export type AppFetch = (request: Request, env: InternalRequestEnv) => Response | Promise<Response>;
export interface McpEndpointOptions {
    fetch: AppFetch;
    mcpConfig?: Config['mcp'];
}

export function createMcpEndpoint(options: McpEndpointOptions): Handler {
    const mcpConfig = options.mcpConfig ?? config.mcp;
    const allowlist = createAllowlistProvider({
        patterns: mcpConfig.routes,
        loadNamespaces: async () => {
            await ensureNamespacesLoaded([...new Set(mcpConfig.routes.map((pattern) => pattern.split('/', 2)[1]).filter(Boolean))]);
            return namespaces;
        },
    });
    const deps = {
        mcpConfig,
        allowlist,
        limiter: createLimiter(mcpConfig),
        dispatcher: createFeedDispatcher(options.fetch),
        redact: createRedactor(config),
        cacheAvailable: () => cache.status.available,
        log: (line: string) => {
            logger.info(line);
        },
    };
    const handler = createMcpHandler((ctx) => buildMcpServer(deps, ctx.requestInfo), { legacy: 'stateless', responseMode: 'json', maxRequestBodySize: 65536 });
    return async (ctx) => {
        const rejected = checkOrigin(ctx.req.raw, mcpConfig);
        if (rejected) {
            logger.warn('mcp: rejected origin');
            return rejected;
        }
        try {
            const response = await handler.fetch(ctx.req.raw);
            // The Node entry replaces fetch globals after node-server loads. Copy Headers across
            // those realms so node-server's cached-response path preserves the SDK content type.
            return new Response(response.body, { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers) });
        } catch {
            return ctx.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }, 500);
        }
    };
}
