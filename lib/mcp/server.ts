import { McpServer } from '@modelcontextprotocol/server';

import type { ToolDeps } from './twitter-tools';
import { registerTwitterTools } from './twitter-tools';

export type { ToolDeps } from './twitter-tools';
export function buildMcpServer(deps: ToolDeps, request?: Request): McpServer {
    const server = new McpServer({ name: 'rsshub', version: '1.0.0' });
    registerTwitterTools(server, deps, request);
    return server;
}
