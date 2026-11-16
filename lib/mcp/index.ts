import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Handler } from 'hono';

import type { Config } from '@/config';
import { config } from '@/config';
import logger from '@/utils/logger';

import { createRedactor } from './errors';
import { createLimiter } from './limiter';
import { checkOrigin } from './origin';
import { buildMcpServer } from './server';
import type { TwitterSource } from './twitter-source';
import { createTwitterSource } from './twitter-source';
import { toolNames } from './twitter-tools';

export interface McpEndpointOptions {
    mcpConfig?: Config['mcp'];
    twitter?: TwitterSource;
}
export function createMcpEndpoint(options: McpEndpointOptions = {}): Handler {
    const mcpConfig = options.mcpConfig ?? config.mcp;
    const configuredTools = new Set(mcpConfig.tools);
    for (const name of configuredTools) {
        if (!(toolNames as readonly string[]).includes(name)) {
            logger.warn(`MCP: unknown tool ${name}; ignored`);
        }
    }
    if (process.env.MCP_ROUTES !== undefined || process.env.MCP_MAX_ITEMS !== undefined) {
        logger.warn('MCP_ROUTES and MCP_MAX_ITEMS are ignored; MCP_TOOLS controls tool exposure');
    }
    if (!config.twitter.thirdPartyApi && !config.twitter.authToken?.some(Boolean) && !(config.twitter.consumerKey && config.twitter.consumerSecret)) {
        logger.warn('MCP Twitter backend is not configured; tools will return source_config_missing');
    }
    const deps = {
        mcpConfig,
        twitter: options.twitter ?? createTwitterSource(),
        limiter: createLimiter(mcpConfig),
        redact: createRedactor(config),
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
