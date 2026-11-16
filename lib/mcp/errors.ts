import type { CallToolResult } from '@modelcontextprotocol/server';

import type { Config } from '@/config';
import { config } from '@/config';

import { clipText } from './text';

export type McpErrorCode = 'invalid_parameter' | 'not_found' | 'invalid_cursor' | 'source_config_missing' | 'upstream_rate_limited' | 'upstream_error' | 'capacity_exceeded' | 'timeout' | 'internal_error';
export interface McpToolError {
    code: McpErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    phase?: 'queued' | 'running';
}
const messages: Record<McpErrorCode, string> = {
    invalid_parameter: 'The Twitter parameter is invalid.',
    not_found: 'The requested post was not found.',
    invalid_cursor: 'This cursor is malformed or does not belong to this query or backend; call again without cursor.',
    source_config_missing: 'The source requires configuration.',
    upstream_rate_limited: 'The source rate limit was reached.',
    upstream_error: 'The source request failed.',
    capacity_exceeded: 'MCP request capacity was exceeded.',
    timeout: 'The MCP request deadline expired.',
    internal_error: 'An internal MCP error occurred.',
};
const retryable = new Set<McpErrorCode>(['upstream_rate_limited', 'upstream_error', 'capacity_exceeded', 'timeout']);
const errorNames: Record<string, McpErrorCode> = {
    NotFoundError: 'not_found',
    InvalidCursorError: 'invalid_cursor',
    InvalidParameterError: 'invalid_parameter',
    ConfigNotFoundError: 'source_config_missing',
    McpCapacityError: 'capacity_exceeded',
};
type ErrorLike = { name?: string; message?: string; statusCode?: number; status?: number; response?: { status?: number; headers?: Headers | Record<string, unknown> } };

function redactUrl(match: string): string {
    let suffix = match.match(/[)\]]+$/)?.[0] ?? '';
    let url: URL;
    try {
        url = new URL(suffix ? match.slice(0, -suffix.length) : match);
    } catch {
        try {
            // A final bracket may belong to an IPv6 host rather than surrounding markup.
            url = new URL(match);
            suffix = '';
        } catch {
            return '[redacted]' + suffix;
        }
    }
    if (!url.username && !url.password && !url.search && !url.hash) {
        return match;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href + '[redacted]' + suffix;
}

export function createRedactor(settings: Config): (text: string) => string {
    const secrets = new Set<string>();
    const seen = new WeakSet<object>();
    const seenSensitive = new WeakSet<object>();
    const visit = (value: unknown, sensitive = false) => {
        if (typeof value === 'string') {
            if (sensitive && value.length >= 6) {
                secrets.add(value);
            }
        } else if (value && typeof value === 'object') {
            const visited = sensitive ? seenSensitive : seen;
            if (visited.has(value)) {
                return;
            }
            visited.add(value);
            for (const [key, child] of Object.entries(value)) {
                visit(child, sensitive || /token|secret|password|passwd|cookie|key|auth|session|credential/i.test(key));
            }
        }
    };
    visit(settings);
    const ordered = [...secrets].sort((a, b) => b.length - a.length);
    return (text) => {
        let result = text.replaceAll(/https?:\/\/[^\s"'<>\\]+/g, (match) => redactUrl(match));
        for (const secret of ordered) {
            result = result.replaceAll(secret, '[redacted]');
        }
        return result;
    };
}

export function classifyError(error: unknown): McpToolError {
    const value: ErrorLike = error && typeof error === 'object' ? error : { message: String(error) };
    const detail = typeof value.message === 'string' ? value.message : '';
    const status = value.statusCode ?? value.status ?? value.response?.status;
    const namedCode = Object.hasOwn(errorNames, value.name || '') ? errorNames[value.name || ''] : undefined;
    const code: McpErrorCode = namedCode || (status === 429 || /\berror:?\s*429\b/i.test(detail) ? 'upstream_rate_limited' : 'upstream_error');
    const safeDetail = clipText(createRedactor(config)(detail), 300);
    const result: McpToolError = { code, message: clipText(messages[code] + (safeDetail && code !== 'invalid_cursor' ? ` ${safeDetail}` : ''), 300), retryable: retryable.has(code) };
    if (code === 'upstream_rate_limited' && value.response?.headers) {
        const headers = value.response.headers;
        const headerValue = typeof headers.get === 'function' ? headers.get('Retry-After') : Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
        const retryAfter = Array.isArray(headerValue) ? headerValue[0] : headerValue;
        if (typeof retryAfter === 'string' && retryAfter) {
            const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
            if (Number.isFinite(seconds)) {
                result.retryAfterSeconds = Math.max(0, seconds);
            }
        }
    }
    return result;
}

export function toolError(error: McpToolError): CallToolResult {
    const structuredContent = { error };
    return { isError: true, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
}

export function errorForCode(code: McpErrorCode, phase?: 'queued' | 'running'): McpToolError {
    return { code, message: messages[code], retryable: retryable.has(code), ...(phase && { phase }) };
}
