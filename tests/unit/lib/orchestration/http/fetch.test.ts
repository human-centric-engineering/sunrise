/**
 * Tests for `lib/orchestration/http/fetch.ts`.
 *
 * Focused on the unified executor's distinct concerns: orchestration of
 * allowlist + auth + idempotency + response handling, plus the
 * `HttpResponseBody` output shape (status, body, latencyMs,
 * optional transformError).
 *
 * The legacy edge cases (every status code, every response transform
 * variant, etc.) are exercised through the existing `external-call`
 * executor regression suite; this file does not re-litigate them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAllowlistCache } from '@/lib/orchestration/http/allowlist';
import { HttpError } from '@/lib/orchestration/http/errors';
import { executeHttpRequest } from '@/lib/orchestration/http/fetch';
import { resetOutboundRateLimiters } from '@/lib/orchestration/engine/outbound-rate-limiter';

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('executeHttpRequest', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllowlistCache();
    resetOutboundRateLimiters();
    process.env = {
      ...originalEnv,
      ORCHESTRATION_ALLOWED_HOSTS: 'api.allowed.com',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(text, {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      })
    );
  }

  it('returns status, body, and latencyMs on success', async () => {
    mockResponse(200, { ok: true });
    const out = await executeHttpRequest({
      url: 'https://api.allowed.com/v1/x',
      method: 'POST',
      body: '{}',
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(typeof out.latencyMs).toBe('number');
    expect(out.transformError).toBeUndefined();
  });

  it('throws host_not_allowed for hosts outside the allowlist', async () => {
    await expect(
      executeHttpRequest({ url: 'https://evil.com/x', method: 'GET' })
    ).rejects.toMatchObject({ code: 'host_not_allowed', retriable: false });
  });

  it('attaches bearer auth header from env-var secret', async () => {
    process.env.MY_TOKEN = 'sk_test_abc';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeHttpRequest({
      url: 'https://api.allowed.com/v1/x',
      method: 'POST',
      body: '{}',
      auth: { type: 'bearer', secret: 'MY_TOKEN' },
    });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_abc');
  });

  it('attaches idempotency header when configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeHttpRequest({
      url: 'https://api.allowed.com/v1/charge',
      method: 'POST',
      body: '{"amount":100}',
      idempotency: { key: 'order_42' },
    });

    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('order_42');
  });

  it('authHeaders override case-different opts.headers (closes smuggling path)', async () => {
    // Security regression: an opts.headers entry like `authorization`
    // (lowercase) must not coexist with the canonical `Authorization`
    // produced by applyAuth — fetch's Headers ctor would otherwise
    // concatenate them as `authorization: attacker, Bearer real`.
    process.env.MY_TOKEN = 'sk_real';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeHttpRequest({
      url: 'https://api.allowed.com/v1/x',
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer attacker' },
      auth: { type: 'bearer', secret: 'MY_TOKEN' },
    });

    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const authEntries = Object.entries(headers).filter(
      ([k]) => k.toLowerCase() === 'authorization'
    );
    expect(authEntries).toHaveLength(1);
    expect(authEntries[0]?.[1]).toBe('Bearer sk_real');
  });

  it('omits body and Content-Type for GET requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeHttpRequest({
      url: 'https://api.allowed.com/v1/x',
      method: 'GET',
      body: '{"ignored":true}',
    });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('throws http_error_retriable for 503 responses', async () => {
    mockResponse(503, 'service down');
    await expect(
      executeHttpRequest({ url: 'https://api.allowed.com/x', method: 'GET' })
    ).rejects.toMatchObject({ code: 'http_error_retriable', retriable: true, status: 503 });
  });

  it('throws non-retriable http_error for 400 responses', async () => {
    mockResponse(400, 'bad request');
    await expect(
      executeHttpRequest({ url: 'https://api.allowed.com/x', method: 'GET' })
    ).rejects.toMatchObject({ code: 'http_error', retriable: false, status: 400 });
  });

  it('throws request_aborted when caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeHttpRequest({
        url: 'https://api.allowed.com/x',
        method: 'GET',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'request_aborted' });
  });

  it('returns body with transformError when transform throws', async () => {
    mockResponse(200, { a: 1 });
    const out = await executeHttpRequest({
      url: 'https://api.allowed.com/x',
      method: 'GET',
      responseTransform: { type: 'jmespath', expression: 'invalid syntax !!!' },
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ a: 1 });
    expect(out.transformError).toBeTruthy();
  });

  it('applies a successful transform and returns the transformed body', async () => {
    mockResponse(200, { user: { id: 'u1' } });
    const out = await executeHttpRequest({
      url: 'https://api.allowed.com/x',
      method: 'GET',
      responseTransform: { type: 'jmespath', expression: 'user.id' },
    });
    expect(out.body).toBe('u1');
    expect(out.transformError).toBeUndefined();
  });

  it('HttpError carries cause for network failures', async () => {
    const cause = new Error('econnrefused');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause);
    try {
      await executeHttpRequest({ url: 'https://api.allowed.com/x', method: 'GET' });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('request_failed');
      expect((err as HttpError).cause).toBe(cause);
    }
  });
});
