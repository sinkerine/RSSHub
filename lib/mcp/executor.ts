import type { CallToolResult } from '@modelcontextprotocol/server';

import type { Config } from '@/config';

import type { McpErrorCode } from './errors';
import { classifyError, errorForCode, toolError } from './errors';
import type { Limiter } from './limiter';
import { CapacityError, LimiterAbortError } from './limiter';
import { clipText } from './text';

export interface ToolResult {
    output: Record<string, unknown>;
    trim(): boolean;
}
export interface ExecutorDeps {
    mcpConfig: Config['mcp'];
    limiter: Limiter;
    redact(text: string): string;
    log(line: string): void;
}
export async function runTool(name: string, deps: ExecutorDeps, signals: AbortSignal[], work: () => Promise<ToolResult>, validate?: () => void): Promise<CallToolResult> {
    const started = performance.now();
    let status: McpErrorCode | 'ok' | 'cancelled' = 'ok';
    let deadline: AbortSignal | undefined;
    try {
        validate?.();
        deadline = AbortSignal.timeout(deps.mcpConfig.timeout * 1000);
        const result = await deps.limiter.run(
            async () => {
                const value = await work();
                while (Buffer.byteLength(JSON.stringify(value.output)) > deps.mcpConfig.maxResponseBytes) {
                    if (!value.trim()) {
                        throw new Error('MCP response cannot fit byte bound');
                    }
                }
                return value.output;
            },
            AbortSignal.any([...signals, deadline])
        );
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
        if (error instanceof LimiterAbortError && !deadline?.aborted) {
            status = 'cancelled';
            throw error;
        }
        const failure =
            error instanceof CapacityError
                ? errorForCode('capacity_exceeded')
                : error instanceof LimiterAbortError
                  ? errorForCode('timeout', error.phase)
                  : error instanceof Error && error.message === 'MCP response cannot fit byte bound'
                    ? errorForCode('internal_error')
                    : classifyError(error);
        status = failure.code;
        return toolError({ ...failure, message: clipText(deps.redact(failure.message), 300) });
    } finally {
        deps.log(`mcp ${name} ${status} ${Math.round(performance.now() - started)}ms`);
    }
}
