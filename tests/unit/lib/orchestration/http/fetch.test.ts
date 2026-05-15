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

  it('preserves structured error bodies up to 2 KB and marks longer ones as truncated', async () => {
    // ~1.5 KB structured body — well within the cap, must NOT be cut.
    const longBody = 'X'.repeat(1500);
    mockResponse(422, longBody);
    await expect(
      executeHttpRequest({ url: 'https://api.allowed.com/x', method: 'GET' })
    ).rejects.toMatchObject({
      code: 'http_error',
      message: expect.stringContaining('XXXXXX'),
    });
  });

  it('marks oversize error bodies with a truncation suffix so operators know more existed', async () => {
    // 3 KB body — past the 2 KB cap. The HttpError message should be cut
    // at 2000 chars and carry an explicit "[truncated, N more chars]"
    // suffix so the diagnostic isn't silently lost.
    const oversizeBody = 'Y'.repeat(3000);
    mockResponse(422, oversizeBody);

    let captured: { message?: string } = {};
    try {
      await executeHttpRequest({ url: 'https://api.allowed.com/x', method: 'GET' });
    } catch (err) {
      captured = err as { message?: string };
    }
    expect(captured.message).toContain('… [truncated,');
    expect(captured.message).toMatch(/1000 more chars/);
  });

  it('still throws http_error when reading the error body itself fails', async () => {
    // Exercises the `.catch(() => '')` arm — non-2xx response whose text()
    // rejects (e.g. abort during body read). The HttpError still surfaces
    // with an empty body preview rather than masking the upstream failure.
    const errorResponse = new Response(null, { status: 500 });
    Object.defineProperty(errorResponse, 'text', {
      value: () => Promise.reject(new Error('body read failed')),
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse);

    await expect(
      executeHttpRequest({ url: 'https://api.allowed.com/x', method: 'GET' })
    ).rejects.toMatchObject({ code: 'http_error', status: 500 });
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

  it('aborts in-flight when caller signal triggers mid-request', async () => {
    // Exercises the `onExternalAbort` listener: the caller's signal aborts
    // AFTER fetch has been kicked off but before it resolves. The listener
    // forwards to the internal AbortController, which propagates to the
    // mocked fetch and surfaces as request_timeout (AbortError → name
    // === 'AbortError' branch in fetch.ts).
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const initSignal = init?.signal;
      return new Promise<Response>((_, reject) => {
        initSignal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const promise = executeHttpRequest({
      url: 'https://api.allowed.com/x',
      method: 'GET',
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    queueMicrotask(() => controller.abort());

    await expect(promise).rejects.toMatchObject({ code: 'request_timeout' });
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
    expect(typeof out.transformError).toBe('string');
    expect(out.transformError!.length).toBeGreaterThan(0);
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

  // ─── multipart/form-data body handling ─────────────────────────────

  describe('FormData body', () => {
    function spyJson200(): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    it('passes the FormData to fetch verbatim', async () => {
      const fetchSpy = spyJson200();
      const fd = new FormData();
      fd.append('file', new File([new Uint8Array([1, 2, 3])], 'x.bin'));

      await executeHttpRequest({
        url: 'https://api.allowed.com/x',
        method: 'POST',
        body: fd,
      });

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(init.body).toBe(fd);
    });

    it('does NOT set the JSON Content-Type default when body is FormData', async () => {
      // undici fills in `multipart/form-data; boundary=…` itself when
      // body is FormData; sending application/json here would
      // mismatch the actual body and break the server-side parser.
      const fetchSpy = spyJson200();
      const fd = new FormData();
      fd.append('field', 'value');

      await executeHttpRequest({
        url: 'https://api.allowed.com/x',
        method: 'POST',
        body: fd,
      });

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBeUndefined();
      expect(headers['content-type']).toBeUndefined();
    });

    it('still applies the host allowlist when body is FormData', async () => {
      const fd = new FormData();
      fd.append('field', 'value');
      await expect(
        executeHttpRequest({
          url: 'https://evil.example.com/x',
          method: 'POST',
          body: fd,
        })
      ).rejects.toMatchObject({ code: 'host_not_allowed' });
    });

    it('rejects HMAC + multipart with multipart_hmac_unsupported (no fetch fired)', async () => {
      const fetchSpy = spyJson200();
      process.env.HMAC_KEY = 'secret';
      const fd = new FormData();
      fd.append('field', 'value');

      await expect(
        executeHttpRequest({
          url: 'https://api.allowed.com/x',
          method: 'POST',
          body: fd,
          auth: { type: 'hmac', secret: 'HMAC_KEY' },
        })
      ).rejects.toMatchObject({ code: 'multipart_hmac_unsupported' });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still allows non-HMAC auth modes alongside FormData (bearer)', async () => {
      process.env.BEARER_KEY = 'tok_abc';
      const fetchSpy = spyJson200();
      const fd = new FormData();
      fd.append('field', 'value');

      await executeHttpRequest({
        url: 'https://api.allowed.com/x',
        method: 'POST',
        body: fd,
        auth: { type: 'bearer', secret: 'BEARER_KEY' },
      });

      const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBe('Bearer tok_abc');
    });

    it('respects an already-aborted signal with a multipart body', async () => {
      const fd = new FormData();
      fd.append('field', 'value');
      const controller = new AbortController();
      controller.abort();

      await expect(
        executeHttpRequest({
          url: 'https://api.allowed.com/x',
          method: 'POST',
          body: fd,
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ code: 'request_aborted' });
    });
  });

  // ─── Coverage gaps surfaced by /test-review (axes: coverage) ─────────
  // These paths are exercised through the capability + workflow tests via
  // indirection; here they're driven directly so fetch.test.ts stands on
  // its own as a focused unit test of executeHttpRequest.

  describe('outbound rate limit', () => {
    it('throws outbound_rate_limited (retriable) when the limiter rejects', async () => {
      // Drive the host's per-minute quota down to 1, fire one allowed
      // call, then assert the second hits the rate-limited branch in
      // executeHttpRequest (lib/orchestration/http/fetch.ts:99-108).
      process.env.ORCHESTRATION_OUTBOUND_RATE_LIMIT = '1';
      resetOutboundRateLimiters();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await executeHttpRequest({ url: 'https://api.allowed.com/x', method: 'GET' });

      const err: unknown = await executeHttpRequest({
        url: 'https://api.allowed.com/x',
        method: 'GET',
      }).catch((e) => e);

      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('outbound_rate_limited');
      expect((err as HttpError).retriable).toBe(true);
    });

    it('records Retry-After from a 429 response so subsequent calls fail with outbound_rate_limited', async () => {
      // The non-2xx branch reads the Retry-After header and feeds it
      // into the outbound rate limiter (fetch.ts:202-203). The next
      // call to the same host within the retry-after window is
      // rejected by the limiter rather than reaching fetch.
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('rate limited', {
          status: 429,
          headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' },
        })
      );

      // First call: 429 propagates as a retriable HttpError.
      const first = await executeHttpRequest({
        url: 'https://api.allowed.com/x',
        method: 'GET',
      }).catch((e) => e);
      expect(first).toBeInstanceOf(HttpError);
      expect((first as HttpError).code).toBe('http_error_retriable');

      // Second call: the rate limiter returns allowed=false and
      // executeHttpRequest throws before fetch is hit again.
      const second = await executeHttpRequest({
        url: 'https://api.allowed.com/x',
        method: 'GET',
      }).catch((e) => e);
      expect(second).toBeInstanceOf(HttpError);
      expect((second as HttpError).code).toBe('outbound_rate_limited');
    });
  });

  describe('internal timeout', () => {
    it('fires the internal AbortController on timeoutMs and surfaces request_timeout', async () => {
      // The previous "abort mid-flight" test exercises the caller's
      // signal. This test covers the OTHER branch — the internal
      // setTimeout(..., timeoutMs) callback at fetch.ts:164. The
      // distinction matters because only this path produces
      // request_timeout (vs request_failed for caller aborts).
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            // Hang until the executor's internal AbortController fires
            // its abort, which the runtime turns into an AbortError
            // rejection on the awaited fetch.
            const signal = init?.signal;
            signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          })
      );

      const err: unknown = await executeHttpRequest({
        url: 'https://api.allowed.com/x',
        method: 'GET',
        timeoutMs: 50,
      }).catch((e) => e);

      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('request_timeout');
      expect((err as HttpError).message).toContain('50ms');
    });
  });

  describe('response size cap', () => {
    it('throws response_too_large when the body exceeds maxResponseBytes', async () => {
      // readResponseBody throws on cap exceeded; the catch around it
      // wraps non-HttpError into HttpError('response_too_large')
      // (fetch.ts:230-237). This drives the path directly without
      // the capability layer.
      const big = 'a'.repeat(2048);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(big, {
          status: 200,
          headers: { 'Content-Type': 'text/plain', 'Content-Length': String(big.length) },
        })
      );

      const err: unknown = await executeHttpRequest({
        url: 'https://api.allowed.com/x',
        method: 'GET',
        maxResponseBytes: 100,
      }).catch((e) => e);

      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('response_too_large');
    });
  });
});
