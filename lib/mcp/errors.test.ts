import { http, HttpResponse } from 'msw';
import { ofetch } from 'ofetch';
import { describe, expect, it } from 'vitest';

import { config } from '@/config';
import server from '@/setup.test';

import { classifyError, createRedactor, toolError } from './errors';
import { textContent } from './test-harness';

describe('MCP errors', () => {
    it.each([
        ['NotFoundError', 'route_not_found', false],
        ['InvalidParameterError', 'invalid_parameter', false],
        ['ConfigNotFoundError', 'source_config_missing', false],
        ['RejectError', 'access_denied', false],
        ['CaptchaError', 'captcha_required', false],
        ['RequestInProgressError', 'request_in_progress', true],
        ['Error', 'upstream_error', true],
    ])('classifies %s by name', (name, code, retryable) => {
        const error = new Error('detail');
        Object.defineProperty(error, 'name', { value: name });
        expect(classifyError(error)).toMatchObject({ code, retryable });
    });
    it.each(['constructor', 'toString', '__proto__'])('keeps unknown error name %s in the closed taxonomy', (name) => {
        expect(classifyError({ name, message: 'unknown source error' })).toMatchObject({ code: 'upstream_error', retryable: true });
    });
    it('redacts a config object also reachable through a noncredential alias', () => {
        const shared = { value: 'aliasSecret' };
        const redact = createRedactor({ ...config, publicAlias: shared, auth: shared } as unknown as typeof config);
        expect(redact('aliasSecret')).toBe('[redacted]');
    });
    it('classifies empty and all 429 representations, preserving name precedence', () => {
        expect(classifyError(new Error('this route is empty, no items'))).toMatchObject({ code: 'empty_result', retryable: false });
        for (const error of [{ statusCode: 429 }, { status: 429 }, { response: { status: 429 } }, new Error('Twitter API error: 429')]) {
            expect(classifyError(error)).toMatchObject({ code: 'upstream_rate_limited', retryable: true });
        }
        expect(classifyError({ name: 'ConfigNotFoundError', statusCode: 429 })).toMatchObject({ code: 'source_config_missing' });
    });
    it('classifies real ofetch 429 with Retry-After and HTTP dates', async () => {
        server.use(http.get('http://rsshub.test/mcp-rate', () => HttpResponse.text('rate', { status: 429, headers: { 'Retry-After': '120' } })));
        let error: unknown;
        try {
            await ofetch('http://rsshub.test/mcp-rate', { retry: 0 });
        } catch (error_) {
            error = error_;
        }
        expect(classifyError(error)).toMatchObject({ code: 'upstream_rate_limited', retryAfterSeconds: 120 });
        const date = new Date(Date.now() + 60000).toUTCString();
        const response = new Response('', { status: 429, headers: { 'Retry-After': date } });
        expect(classifyError({ response }).retryAfterSeconds).toBeGreaterThan(58);
    });
    it('preserves quoted, Markdown, HTML, newline and backslash formatting around public URLs', () => {
        const redact = createRedactor(config);
        const metadata = 'Visit "https://example.com"\nSee [site](https://example.com)\n<a href="https://example.com/docs">docs</a>\nC:\\notes\\file';
        expect(redact(metadata)).toBe(metadata);
        expect(redact('(https://user:pass@example.com/private?api_key=hidden#fragment)')).toBe('(https://example.com/private[redacted])');
    });
    it('preserves public IPv6 URLs and strips queries after balanced URL path parentheses', () => {
        const redact = createRedactor(config);
        expect(redact('See [https://[::1]/docs] and https://[::1]')).toBe('See [https://[::1]/docs] and https://[::1]');
        expect(redact('(https://user:pass@example.com/path(with)?api_key=hidden)')).toBe('(https://example.com/path(with)[redacted])');
    });
    it('redacts credential strings containing quotes, backslashes and newlines', () => {
        const secret = 'fixture"quoted\\credential\nsecret';
        const redact = createRedactor({ ...config, accessKey: secret });
        expect(redact(`Credential: ${secret}`)).toBe('Credential: [redacted]');
    });
    it('clips error detail without splitting a surrogate pair at 300 UTF-16 units', () => {
        const output = classifyError(new Error('a'.repeat(299) + '🔥'));
        expect(output.message.length).toBeLessThanOrEqual('The source request failed. '.length + 300);
        expect(output.message.isWellFormed()).toBe(true);
        const serialized = JSON.stringify(output);
        expect(JSON.parse(serialized).message.isWellFormed()).toBe(true);
    });
    it.each(['retry-after', 'rEtRy-AfTeR'])('extracts %s from records despite unrelated non-ByteString headers', (name) => {
        const output = classifyError({ statusCode: 429, response: { headers: { [name]: '45', 'x-unrelated': '🔥', 'invalid header key': 'ignored' } } });
        expect(output).toMatchObject({ code: 'upstream_rate_limited', retryable: true, retryAfterSeconds: 45 });
    });
    it('keeps existing array-header compatibility without treating it as a reproduced defect', () => {
        const output = classifyError({ statusCode: 429, response: { headers: { 'retry-after': '45', 'set-cookie': ['a=1', 'b=2'] } } });
        expect(output).toMatchObject({ code: 'upstream_rate_limited', retryable: true, retryAfterSeconds: 45 });
    });
    it('redact recursively reachable config secrets and strip URL queries/userinfo', () => {
        const redact = createRedactor({ ...config, accessKey: 'accessSecret', twitter: { nested: { authToken: ['tokenSecret'] }, password: 'passwordSecret' } } as unknown as typeof config);
        const result = redact('accessSecret tokenSecret passwordSecret https://user:pass@example.com/path?api_key=secret#frag');
        expect(result).not.toMatch(/accessSecret|tokenSecret|passwordSecret|user:pass|api_key=|#frag/);
        expect(result).toContain('[redacted]');
        expect(result).toContain('https://example.com/path');
        const detail = 'x'.repeat(1000);
        const classified = classifyError(new Error(detail));
        const error = toolError(classified);
        expect(error.isError).toBe(true);
        expect(JSON.parse(textContent(error))).toEqual(error.structuredContent);
        expect(JSON.stringify(error)).not.toContain('stack');
    });
});
