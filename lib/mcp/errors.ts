import type { CallToolResult } from '@modelcontextprotocol/server';

import type { Config } from '@/config';
import { config } from '@/config';

import { clipText } from './text';

export type McpErrorCode =
    | 'invalid_arguments'
    | 'route_not_allowed'
    | 'route_not_found'
    | 'invalid_parameter'
    | 'source_config_missing'
    | 'access_denied'
    | 'captcha_required'
    | 'upstream_rate_limited'
    | 'upstream_error'
    | 'request_in_progress'
    | 'empty_result'
    | 'unsupported_result'
    | 'capacity_exceeded'
    | 'timeout'
    | 'internal_error';
export interface McpToolError {
    code: McpErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    phase?: 'queued' | 'running';
}
const messages: Record<McpErrorCode, string> = {
    invalid_arguments: 'The feed path is invalid.',
    route_not_allowed: 'This feed route is not allowed.',
    route_not_found: 'The feed route was not found.',
    invalid_parameter: 'The route parameter is invalid.',
    source_config_missing: 'The source requires configuration.',
    access_denied: 'Access to the source was denied.',
    captcha_required: 'The source requires a CAPTCHA.',
    upstream_rate_limited: 'The source rate limit was reached.',
    upstream_error: 'The source request failed.',
    request_in_progress: 'This feed is already being fetched.',
    empty_result: 'The source returned an empty feed.',
    unsupported_result: 'The route did not return feed items.',
    capacity_exceeded: 'MCP request capacity was exceeded.',
    timeout: 'The MCP request deadline expired.',
    internal_error: 'An internal MCP error occurred.',
};
const retryable = new Set<McpErrorCode>(['upstream_rate_limited', 'upstream_error', 'request_in_progress', 'capacity_exceeded', 'timeout']);
const errorNames: Record<string, McpErrorCode> = {
    NotFoundError: 'route_not_found',
    InvalidParameterError: 'invalid_parameter',
    ConfigNotFoundError: 'source_config_missing',
    RejectError: 'access_denied',
    CaptchaError: 'captcha_required',
    RequestInProgressError: 'request_in_progress',
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
    const code: McpErrorCode = namedCode || (detail.startsWith('this route is empty') ? 'empty_result' : status === 429 || /\berror:?\s*429\b/i.test(detail) ? 'upstream_rate_limited' : 'upstream_error');
    const safeDetail = clipText(createRedactor(config)(detail), 300);
    const result: McpToolError = { code, message: messages[code] + (safeDetail ? ` ${safeDetail}` : ''), retryable: retryable.has(code) };
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
