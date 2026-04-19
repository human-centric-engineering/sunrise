/**
 * Tests for `lib/orchestration/engine/executors/external-call.ts`.
 *
 * Covers:
 *   - Happy path: successful HTTP call returns parsed JSON body.
 *   - Missing URL → ExecutorError('missing_url').
 *   - Host not in allowlist → ExecutorError('host_not_allowed') (non-retriable).
 *   - Auth header resolution (bearer, api-key, query-param).
 *   - Missing auth secret → ExecutorError('missing_auth_secret') (non-retriable).
 *   - GET/DELETE requests omit body and Content-Type.
 *   - Non-2xx response → classified as retriable (429, 502, 503, 504) or non-retriable.
 *   - Retry-After header recorded on 429.
 *   - Response size limit enforcement.
 *   - Outbound rate limiting.
 *   - Request timeout handling.
 *   - Observability logging.
 *   - Content-type aware response parsing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  interpolatePrompt: vi.fn((template: string) => template),
}));
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import {
  executeExternalCall,
  resetAllowlistCache,
} from '@/lib/orchestration/engine/executors/external-call';
import { resetOutboundRateLimiters } from '@/lib/orchestration/engine/outbound-rate-limiter';
import { logger } from '@/lib/logging';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { message: 'test' },
    stepOutputs: {},
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      withContext: vi.fn().mockReturnThis(),
    } as any,
    ...overrides,
  };
}

function makeStep(overrides?: Partial<WorkflowStep['config']>): WorkflowStep {
  return {
    id: 'ext1',
    name: 'Test External Call',
    type: 'external_call',
    config: {
      url: 'https://api.allowed.com/v1/process',
      method: 'POST',
      bodyTemplate: '{"data": "test"}',
      timeoutMs: 5000,
      ...overrides,
    },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeExternalCall', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllowlistCache();
    resetOutboundRateLimiters();
    process.env = {
      ...originalEnv,
      ORCHESTRATION_ALLOWED_HOSTS: 'api.allowed.com,other.allowed.com',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ─── Happy path ──────────────────────────────────────────────────────

  it('returns parsed JSON response on success', async () => {
    const mockResponse = { result: 'success' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await executeExternalCall(makeStep(), makeCtx());

    expect(result).toMatchObject({
      output: { status: 200, body: mockResponse },
      tokensUsed: 0,
      costUsd: 0,
    });
  });

  it('returns text response when content-type is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('plain text response', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    const result = await executeExternalCall(makeStep(), makeCtx());
    expect(result.output).toMatchObject({ status: 200, body: 'plain text response' });
  });

  it('logs request and response metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeExternalCall(makeStep(), makeCtx());

    expect(logger.info).toHaveBeenCalledWith(
      'External call: sending request',
      expect.objectContaining({
        stepId: 'ext1',
        method: 'POST',
        hostname: 'api.allowed.com',
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      'External call: success',
      expect.objectContaining({
        stepId: 'ext1',
        status: 200,
      })
    );
  });

  // ─── URL validation ──────────────────────────────────────────────────

  it('throws "missing_url" when URL is empty', async () => {
    await expect(executeExternalCall(makeStep({ url: '' }), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_url',
    });
  });

  it('throws "missing_url" when URL is absent', async () => {
    await expect(
      executeExternalCall(makeStep({ url: undefined }), makeCtx())
    ).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_url',
    });
  });

  it('throws non-retriable "host_not_allowed" for non-allowlisted host', async () => {
    const err: any = await executeExternalCall(
      makeStep({ url: 'https://evil.com/attack' }),
      makeCtx()
    ).catch((e) => e);

    expect(err.code).toBe('host_not_allowed');
    expect(err.retriable).toBe(false);
  });

  it('throws "host_not_allowed" when allowlist is empty', async () => {
    process.env.ORCHESTRATION_ALLOWED_HOSTS = '';
    resetAllowlistCache();

    await expect(executeExternalCall(makeStep(), makeCtx())).rejects.toMatchObject({
      code: 'host_not_allowed',
    });
  });

  // ─── Auth resolution (fail-fast on missing secrets) ──────────────────

  it('throws non-retriable "missing_auth_secret" when bearer env var is unset', async () => {
    const step = makeStep({ authType: 'bearer', authSecret: 'NONEXISTENT_TOKEN' });

    const err: any = await executeExternalCall(step, makeCtx()).catch((e) => e);

    expect(err.code).toBe('missing_auth_secret');
    expect(err.retriable).toBe(false);
    expect(err.message).toContain('NONEXISTENT_TOKEN');
  });

  it('throws non-retriable "missing_auth_secret" for api-key auth with unset env var', async () => {
    const step = makeStep({ authType: 'api-key', authSecret: 'NONEXISTENT_KEY' });

    const err: any = await executeExternalCall(step, makeCtx()).catch((e) => e);
    expect(err.code).toBe('missing_auth_secret');
    expect(err.retriable).toBe(false);
  });

  it('throws non-retriable "missing_auth_secret" for query-param auth with unset env var', async () => {
    const step = makeStep({ authType: 'query-param', authSecret: 'NONEXISTENT_KEY' });

    const err: any = await executeExternalCall(step, makeCtx()).catch((e) => e);
    expect(err.code).toBe('missing_auth_secret');
    expect(err.retriable).toBe(false);
  });

  it('includes bearer auth header when configured', async () => {
    process.env.MY_TOKEN = 'secret123';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeExternalCall(makeStep({ authType: 'bearer', authSecret: 'MY_TOKEN' }), makeCtx());

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret123',
        }),
      })
    );
  });

  it('includes API key header when configured', async () => {
    process.env.MY_API_KEY = 'key456';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeExternalCall(
      makeStep({ authType: 'api-key', authSecret: 'MY_API_KEY' }),
      makeCtx()
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'key456',
        }),
      })
    );
  });

  it('appends query-param auth to URL', async () => {
    process.env.MAP_KEY = 'mapkey789';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeExternalCall(
      makeStep({
        authType: 'query-param',
        authSecret: 'MAP_KEY',
        authQueryParam: 'key',
      }),
      makeCtx()
    );

    const calledUrl = (fetch as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain('key=mapkey789');
  });

  it('uses "api_key" as default query param name', async () => {
    process.env.MAP_KEY = 'mapkey789';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeExternalCall(
      makeStep({ authType: 'query-param', authSecret: 'MAP_KEY' }),
      makeCtx()
    );

    const calledUrl = (fetch as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain('api_key=mapkey789');
  });

  // ─── HTTP method behavior ────────────────────────────────────────────

  it('omits body and Content-Type for GET requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeExternalCall(
      makeStep({ method: 'GET', bodyTemplate: '{"ignored": true}' }),
      makeCtx()
    );

    const [, init] = (fetch as any).mock.calls[0];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('omits body and Content-Type for DELETE requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeExternalCall(makeStep({ method: 'DELETE' }), makeCtx());

    const [, init] = (fetch as any).mock.calls[0];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('supports PATCH method', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeExternalCall(makeStep({ method: 'PATCH' }), makeCtx());

    const [, init] = (fetch as any).mock.calls[0];
    expect(init.method).toBe('PATCH');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  // ─── HTTP error classification ───────────────────────────────────────

  it('throws retriable error for 429 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Rate limited', { status: 429 }));

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);

    expect(err.code).toBe('http_error_retriable');
    expect(err.retriable).toBe(true);
  });

  it('throws retriable error for 502 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('http_error_retriable');
    expect(err.retriable).toBe(true);
  });

  it('throws retriable error for 503 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 })
    );

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('http_error_retriable');
    expect(err.retriable).toBe(true);
  });

  it('throws retriable error for 504 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Gateway Timeout', { status: 504 })
    );

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('http_error_retriable');
    expect(err.retriable).toBe(true);
  });

  it('throws non-retriable error for 400 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad Request', { status: 400 }));

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('http_error');
    expect(err.retriable).toBe(false);
  });

  it('throws non-retriable error for 401 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('http_error');
    expect(err.retriable).toBe(false);
  });

  it('throws non-retriable error for 403 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Forbidden', { status: 403 }));

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('http_error');
    expect(err.retriable).toBe(false);
  });

  it('throws non-retriable error for 404 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('http_error');
    expect(err.retriable).toBe(false);
  });

  it('logs warning with body preview for non-2xx responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error": "bad request"}', { status: 400 })
    );

    await executeExternalCall(makeStep(), makeCtx()).catch(() => {});

    expect(logger.warn).toHaveBeenCalledWith(
      'External call: non-2xx response',
      expect.objectContaining({
        status: 400,
        retriable: false,
      })
    );
  });

  // ─── Retry-After header handling ─────────────────────────────────────

  it('records Retry-After header from 429 response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('Rate limited', {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      )
      .mockResolvedValueOnce(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    // First call: 429 with Retry-After.
    await executeExternalCall(makeStep(), makeCtx()).catch(() => {});

    // Second call: should be blocked by outbound rate limiter's Retry-After window.
    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('outbound_rate_limited');
  });

  // ─── Response size limit ─────────────────────────────────────────────

  it('throws "response_too_large" when response exceeds maxResponseBytes', async () => {
    const largeBody = 'x'.repeat(2000);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(largeBody, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    const step = makeStep({ maxResponseBytes: 100 });
    const err: any = await executeExternalCall(step, makeCtx()).catch((e) => e);

    expect(err.code).toBe('response_too_large');
    expect(err.retriable).toBe(false);
  });

  it('uses default 1MB limit when maxResponseBytes not specified', async () => {
    // This should pass — response is well under 1MB.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await executeExternalCall(makeStep(), makeCtx());
    expect(result.output).toMatchObject({ status: 200 });
  });

  // ─── Outbound rate limiting ──────────────────────────────────────────

  it('throws retriable "outbound_rate_limited" when host rate limit exceeded', async () => {
    // Set a very low limit.
    process.env.ORCHESTRATION_OUTBOUND_RATE_LIMIT = '2';
    resetOutboundRateLimiters();

    // Each call needs a fresh Response (body streams can only be read once).
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    // First two calls should succeed.
    await executeExternalCall(makeStep(), makeCtx());
    await executeExternalCall(makeStep(), makeCtx());

    // Third call should be rate limited (before fetch is even called).
    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('outbound_rate_limited');
    expect(err.retriable).toBe(true);
  });

  // ─── Timeout and abort ───────────────────────────────────────────────

  it('throws "request_failed" on fetch network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    await expect(executeExternalCall(makeStep(), makeCtx())).rejects.toMatchObject({
      code: 'request_failed',
    });
  });

  it('throws "request_aborted" when execution signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeExternalCall(makeStep(), makeCtx({ signal: controller.signal }))
    ).rejects.toMatchObject({
      code: 'request_aborted',
    });
  });

  // ─── Allowlist caching ───────────────────────────────────────────────

  it('does not re-parse allowlist on every call when env var is unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    // Two calls with the same env var value should both succeed.
    await executeExternalCall(makeStep(), makeCtx());
    await executeExternalCall(makeStep(), makeCtx());

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes cache when env var value changes after reset', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await executeExternalCall(makeStep(), makeCtx());

    // Change env and reset cache.
    process.env.ORCHESTRATION_ALLOWED_HOSTS = '';
    resetAllowlistCache();

    await expect(executeExternalCall(makeStep(), makeCtx())).rejects.toMatchObject({
      code: 'host_not_allowed',
    });
  });

  // ─── Response body parsing edge cases ───────────────────────────────

  it('parses JSON when body starts with [ (array)', async () => {
    const arr = [1, 2, 3];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(arr), {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }, // no json content-type
      })
    );

    const result = await executeExternalCall(makeStep(), makeCtx());
    // Body starts with '[' so JSON.parse should kick in
    expect(result.output).toMatchObject({ status: 200, body: [1, 2, 3] });
  });

  it('returns raw text when JSON parse fails despite json-looking content type', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not valid json {{', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await executeExternalCall(makeStep(), makeCtx());
    // Falls through to raw text on parse failure
    expect(result.output).toMatchObject({ status: 200, body: 'not valid json {{' });
  });

  it('throws response_too_large when content-length header exceeds maxResponseBytes', async () => {
    // Simulate a response that reports a large content-length without actually
    // sending a large body (to test the header check specifically).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('small body', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': '2000000', // 2 MB
        },
      })
    );

    const step = makeStep({ maxResponseBytes: 500 });
    const err: any = await executeExternalCall(step, makeCtx()).catch((e) => e);
    expect(err.code).toBe('response_too_large');
  });

  // ─── Response transformation ─────────────────────────────────────────

  it('applies jmespath transform to extract a nested field', async () => {
    const mockBody = { results: [{ id: 1, name: 'Alice' }], total: 1 };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const step = makeStep({
      responseTransform: { type: 'jmespath', expression: 'results[0].name' },
    });

    const result = await executeExternalCall(step, makeCtx());
    expect(result.output).toMatchObject({ status: 200, body: 'Alice' });
  });

  it('applies template transform to interpolate body fields', async () => {
    const mockBody = { user: { name: 'Bob', id: '42' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const step = makeStep({
      responseTransform: { type: 'template', expression: 'Hello {{user.name}} (id={{user.id}})' },
    });

    const result = await executeExternalCall(step, makeCtx());
    expect(result.output).toMatchObject({ status: 200, body: 'Hello Bob (id=42)' });
  });

  it('template transform returns empty string for missing path', async () => {
    const mockBody = { name: 'Charlie' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const step = makeStep({
      responseTransform: { type: 'template', expression: 'Name={{name}}, Missing={{nonexistent}}' },
    });

    const result = await executeExternalCall(step, makeCtx());
    expect(result.output).toMatchObject({ status: 200, body: 'Name=Charlie, Missing=' });
  });

  it('returns full body with _transformError when transform throws', async () => {
    // Arrange: jmespath with an invalid expression
    const mockBody = { value: 42 };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const step = makeStep({
      responseTransform: {
        type: 'jmespath',
        // jmespath throws on invalid syntax
        expression: '[[[[invalid syntax',
      },
    });

    const result = await executeExternalCall(step, makeCtx());
    // Non-fatal: full body returned with _transformError key
    expect(result.output).toMatchObject({
      status: 200,
      body: mockBody,
      _transformError: expect.any(String),
    });
  });

  // ─── Abort signal propagation ────────────────────────────────────────

  it('throws request_failed with AbortError message on timeout', async () => {
    // Simulate a fetch that throws an AbortError (as from a timeout)
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    const step = makeStep({ timeoutMs: 1 });
    const err: any = await executeExternalCall(step, makeCtx()).catch((e) => e);

    expect(err.code).toBe('request_failed');
    expect(err.message).toContain('timed out');
  });

  // ─── Custom headers passthrough ──────────────────────────────────────

  it('merges custom headers into request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );

    const step = makeStep({ headers: { 'X-Custom-Header': 'custom-value' } });
    await executeExternalCall(step, makeCtx());

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Custom-Header': 'custom-value' }),
      })
    );
  });

  // ─── Default method is POST ──────────────────────────────────────────

  it('defaults to POST when method is not specified', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );

    const step = makeStep({ method: undefined });
    await executeExternalCall(step, makeCtx());

    const [, init] = (fetch as any).mock.calls[0];
    expect(init.method).toBe('POST');
  });
});
