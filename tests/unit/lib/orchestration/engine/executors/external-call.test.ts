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
vi.mock('@/lib/orchestration/engine/dispatch-cache', () => ({
  buildIdempotencyKey: vi.fn(({ executionId, stepId, turnIndex }) =>
    turnIndex !== undefined
      ? `${executionId}:${stepId}:turn=${turnIndex}`
      : `${executionId}:${stepId}`
  ),
  lookupDispatch: vi.fn().mockResolvedValue(null),
  recordDispatch: vi.fn().mockResolvedValue(true),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeExternalCall } from '@/lib/orchestration/engine/executors/external-call';
import { resetAllowlistCache } from '@/lib/orchestration/http/allowlist';
import { resetOutboundRateLimiters } from '@/lib/orchestration/engine/outbound-rate-limiter';
import { logger } from '@/lib/logging';
import {
  buildIdempotencyKey,
  lookupDispatch,
  recordDispatch,
} from '@/lib/orchestration/engine/dispatch-cache';
import type { StepResult, WorkflowStep } from '@/types/orchestration';
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

    // Logging happens in the shared HTTP module — message strings are
    // module-level identifiers, but `stepId` is propagated via
    // `logContext` so admins can still correlate to the workflow step.
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP request: sending',
      expect.objectContaining({
        stepId: 'ext1',
        method: 'POST',
        hostname: 'api.allowed.com',
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP request: success',
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

  // test-review:accept tobe_true — structural assertion on retriable boolean field of ExecutorError
  it('throws retriable error for 429 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Rate limited', { status: 429 }));

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);

    expect(err.code).toBe('http_error_retriable');
    expect(err.retriable).toBe(true);
  });

  // test-review:accept tobe_true — structural assertion on retriable boolean field of ExecutorError
  it('throws retriable error for 502 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('http_error_retriable');
    expect(err.retriable).toBe(true);
  });

  // test-review:accept tobe_true — structural assertion on retriable boolean field of ExecutorError
  it('throws retriable error for 503 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 })
    );

    const err: any = await executeExternalCall(makeStep(), makeCtx()).catch((e) => e);
    expect(err.code).toBe('http_error_retriable');
    expect(err.retriable).toBe(true);
  });

  // test-review:accept tobe_true — structural assertion on retriable boolean field of ExecutorError
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
      'HTTP request: non-2xx response',
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

  // test-review:accept tobe_true — structural assertion on retriable boolean field of ExecutorError
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
    // test-review:accept tobe_true — structural assertion on retriable boolean field of ExecutorError
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

  it('propagates ctx.signal abort fired mid-flight as request_failed', async () => {
    // Arrange: fetch starts but never resolves; we fire the abort mid-flight.
    const execController = new AbortController();

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // When the internal AbortController (linked to both timeout and ctx.signal)
          // fires, fetch rejects with an AbortError — mirroring real browser behaviour.
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }
          // Fire the external (ctx) abort after fetch is already in progress.
          execController.abort();
        })
    );

    // Act: pass the mid-flight abort signal via ctx.
    const err: any = await executeExternalCall(
      makeStep(),
      makeCtx({ signal: execController.signal })
    ).catch((e) => e);

    // Assert: the AbortError surfaced as request_failed (same path as timeout).
    expect(err.code).toBe('request_failed');
  });

  // ─── Allowlist caching ───────────────────────────────────────────────

  it('serves subsequent calls from cached allowlist when env var is unchanged', async () => {
    // Arrange: the cache is empty (reset in beforeEach).
    // Spy on the Set constructor to detect re-parsing — but since we cannot spy
    // on module internals, we validate caching behaviourally: after the env var
    // is changed and then restored to its original value (without resetAllowlistCache),
    // the call should succeed, proving the cache correctly re-parses on value change
    // and re-caches on the restored value.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    // First call: warms the cache with 'api.allowed.com,other.allowed.com'.
    await executeExternalCall(makeStep(), makeCtx());

    // Change env to a different value — cache invalidates.
    process.env.ORCHESTRATION_ALLOWED_HOSTS = 'other.allowed.com';
    // api.allowed.com is no longer in the list, so this must throw.
    await expect(executeExternalCall(makeStep(), makeCtx())).rejects.toMatchObject({
      code: 'host_not_allowed',
    });

    // Restore env to original value — cache re-populates on next call.
    process.env.ORCHESTRATION_ALLOWED_HOSTS = 'api.allowed.com,other.allowed.com';
    // api.allowed.com is back in the list, so the call succeeds again.
    await expect(executeExternalCall(makeStep(), makeCtx())).resolves.toMatchObject({
      output: { status: 200 },
    });
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

  // ─── Env-var template substitution ───────────────────────────────────

  describe('${env:VAR} substitution', () => {
    // Renamed from `originalEnv` to avoid shadowing the outer-describe declaration (Finding 9).
    const innerOriginalEnv = process.env;

    beforeEach(() => {
      // Override to a single-host allowlist — env-var tests only call api.allowed.com
      process.env = { ...innerOriginalEnv, ORCHESTRATION_ALLOWED_HOSTS: 'api.allowed.com' };
    });

    afterEach(() => {
      process.env = innerOriginalEnv;
    });

    it('resolves ${env:VAR} in url config (no workflow-context interpolation needed)', async () => {
      process.env.WEBHOOK_PATH = 'v1/notify';
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );
      const step = makeStep({ url: 'https://api.allowed.com/${env:WEBHOOK_PATH}' });
      await executeExternalCall(step, makeCtx());
      expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.allowed.com/v1/notify');
    });

    it('resolves ${env:VAR} in header values', async () => {
      process.env.UPSTREAM_TOKEN = 'tok_123';
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );
      const step = makeStep({
        headers: { 'X-Upstream': 'Bearer ${env:UPSTREAM_TOKEN}' },
      });
      await executeExternalCall(step, makeCtx());
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Upstream']).toBe('Bearer tok_123');
    });

    it('throws ExecutorError("missing_env_var") when url references an unset env var', async () => {
      delete process.env.MISSING_HOST_PATH;
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const step = makeStep({ url: 'https://api.allowed.com/${env:MISSING_HOST_PATH}' });
      await expect(executeExternalCall(step, makeCtx())).rejects.toMatchObject({
        code: 'missing_env_var',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws ExecutorError("missing_env_var") when a header references an unset env var', async () => {
      delete process.env.MISSING_HEADER_VAR;
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const step = makeStep({
        headers: { 'X-Foo': 'Bearer ${env:MISSING_HEADER_VAR}' },
      });
      await expect(executeExternalCall(step, makeCtx())).rejects.toMatchObject({
        code: 'missing_env_var',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    // ─── Security: order of resolution prevents user-injected env
    //     substitution. interpolatePrompt produces a value containing
    //     `${env:...}` text only when a user passes that string as
    //     workflow input — the env resolver MUST run before
    //     interpolation so user content cannot trigger substitution. ──
    it('does NOT resolve ${env:VAR} when the reference comes from interpolated context, not the admin config', async () => {
      const { interpolatePrompt } = await import('@/lib/orchestration/engine/llm-runner');
      // Real interpolation behaviour for this case: substitute
      // `{{input.message}}` with whatever the user sent.
      vi.mocked(interpolatePrompt).mockImplementationOnce((template: string, c: any) =>
        template.replace('{{input.message}}', c.inputData.message ?? '')
      );

      // Attacker-controlled chat input contains a literal env-template
      // string. If we resolved env templates AFTER interpolation, this
      // would exfiltrate the secret through the URL.
      process.env.SHOULD_NOT_LEAK = 'super-secret';
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );

      const step = makeStep({ url: 'https://api.allowed.com/echo/{{input.message}}' });
      const ctx = makeCtx({ inputData: { message: '${env:SHOULD_NOT_LEAK}' } });
      await executeExternalCall(step, ctx);

      const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
      // The literal `${env:SHOULD_NOT_LEAK}` must survive in the URL —
      // the secret must NOT be substituted in.
      expect(calledUrl).toContain('${env:SHOULD_NOT_LEAK}');
      expect(calledUrl).not.toContain('super-secret');
    });

    it('resolves admin-authored ${env:VAR} BEFORE interpolatePrompt mixes in user content', async () => {
      const { interpolatePrompt } = await import('@/lib/orchestration/engine/llm-runner');
      vi.mocked(interpolatePrompt).mockImplementationOnce((template: string, c: any) =>
        template.replace('{{input.tag}}', c.inputData.tag ?? '')
      );

      process.env.WEBHOOK_BASE = 'https://api.allowed.com/svc';
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );

      const step = makeStep({ url: '${env:WEBHOOK_BASE}/{{input.tag}}' });
      const ctx = makeCtx({ inputData: { tag: 'release-notes' } });
      await executeExternalCall(step, ctx);

      // Admin's env template resolved + user's input value substituted.
      expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.allowed.com/svc/release-notes');
    });

    it('treats env var set to empty string as missing (matches readSecret posture)', async () => {
      process.env.EMPTY_VAR = '';
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const step = makeStep({ url: 'https://api.allowed.com/${env:EMPTY_VAR}' });
      await expect(executeExternalCall(step, makeCtx())).rejects.toMatchObject({
        code: 'missing_env_var',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('preserves env var values that look falsy but are valid strings (e.g. "0")', async () => {
      process.env.ZERO_VAR = '0';
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );
      const step = makeStep({ url: 'https://api.allowed.com/v${env:ZERO_VAR}' });
      await executeExternalCall(step, makeCtx());
      expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.allowed.com/v0');
    });

    it('ignores ${env:lower} and other malformed templates (left as literal in URL)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );
      // Strict pattern means a typo doesn't accidentally substitute or
      // throw — it stays as literal text. This URL is malformed for
      // most real APIs but the env resolver itself is content-blind.
      const step = makeStep({ url: 'https://api.allowed.com/${env:lower}/x' });
      await executeExternalCall(step, makeCtx());
      expect(fetchSpy.mock.calls[0]?.[0]).toContain('${env:lower}');
    });
  });

  // ─── multipart/form-data step config ───────────────────────────────

  describe('multipart body', () => {
    const helloBase64 = Buffer.from('hello').toString('base64');

    it('builds a FormData and passes it to fetch when config.multipart is set', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );
      const step = makeStep({
        bodyTemplate: undefined,
        multipart: {
          files: [{ name: 'index.html', contentType: 'text/html', data: helloBase64 }],
          fields: { paperWidth: '8.5' },
        },
      });
      await executeExternalCall(step, makeCtx());
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get('paperWidth')).toBe('8.5');
      expect((init.body as FormData).get('index.html')).toBeInstanceOf(File);
    });

    it('interpolates {{steps...}} into multipart file data and field values', async () => {
      const { interpolatePrompt } = await import('@/lib/orchestration/engine/llm-runner');
      vi.mocked(interpolatePrompt).mockImplementation((template: string, c: any) => {
        if (template.includes('{{steps.render.body.data}}')) {
          return template.replace('{{steps.render.body.data}}', c.stepOutputs.render.body.data);
        }
        if (template.includes('{{input.tag}}')) {
          return template.replace('{{input.tag}}', c.inputData.tag);
        }
        return template;
      });
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );
      const step = makeStep({
        bodyTemplate: undefined,
        multipart: {
          files: [
            { name: 'index.html', contentType: 'text/html', data: '{{steps.render.body.data}}' },
          ],
          fields: { tag: '{{input.tag}}' },
        },
      });
      const ctx = makeCtx({
        inputData: { tag: 'release-notes' },
        stepOutputs: { render: { body: { data: helloBase64 } } },
      });
      await executeExternalCall(step, ctx);
      const fd = (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as FormData;
      expect(fd.get('tag')).toBe('release-notes');
      expect(fd.get('index.html')).toBeInstanceOf(File);
    });

    it('throws ExecutorError("invalid_base64") when interpolated data is not base64', async () => {
      const { interpolatePrompt } = await import('@/lib/orchestration/engine/llm-runner');
      vi.mocked(interpolatePrompt).mockImplementation((template: string) => {
        if (template === '{{steps.broken.body.data}}') return 'not really base64 !!!';
        return template;
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const step = makeStep({
        bodyTemplate: undefined,
        multipart: {
          files: [{ name: 'doc', contentType: 'text/plain', data: '{{steps.broken.body.data}}' }],
        },
      });
      await expect(executeExternalCall(step, makeCtx())).rejects.toMatchObject({
        code: 'invalid_base64',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('schema rejects bodyTemplate and multipart together', async () => {
      // The mutual-exclusion .refine fires at schema parse time, so
      // executeExternalCall throws on the parse rather than reaching
      // the body-construction branch.
      const step = makeStep({
        bodyTemplate: '{"hello":"world"}',
        multipart: {
          files: [{ name: 'x', contentType: 'text/plain', data: helloBase64 }],
        },
      });
      await expect(executeExternalCall(step, makeCtx())).rejects.toThrow();
    });

    it('config schema rejects multipart with method=GET', async () => {
      const step = makeStep({
        method: 'GET',
        bodyTemplate: undefined,
        multipart: {
          files: [{ name: 'doc', contentType: 'text/plain', data: helloBase64 }],
        },
      });
      await expect(executeExternalCall(step, makeCtx())).rejects.toThrow();
    });

    it('config schema rejects multipart with method=DELETE', async () => {
      const step = makeStep({
        method: 'DELETE',
        bodyTemplate: undefined,
        multipart: {
          files: [{ name: 'doc', contentType: 'text/plain', data: helloBase64 }],
        },
      });
      await expect(executeExternalCall(step, makeCtx())).rejects.toThrow();
    });

    it('maps multipart_hmac_unsupported HttpError → ExecutorError("multipart_hmac_unsupported")', async () => {
      process.env.HMAC_KEY = 'secret';
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const step = makeStep({
        authType: 'hmac',
        authSecret: 'HMAC_KEY',
        bodyTemplate: undefined,
        multipart: {
          files: [{ name: 'doc', contentType: 'text/plain', data: helloBase64 }],
        },
      });
      await expect(executeExternalCall(step, makeCtx())).rejects.toMatchObject({
        code: 'multipart_hmac_unsupported',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Dispatch cache integration ──────────────────────────────────────

  describe('dispatch cache integration', () => {
    const cachedResult: StepResult = {
      output: { status: 200, body: { cached: true } },
      tokensUsed: 0,
      costUsd: 0,
    };

    it('cache hit returns cached StepResult without firing HTTP request', async () => {
      // Arrange: cache already holds a result for this execution+step
      vi.mocked(lookupDispatch).mockResolvedValueOnce(cachedResult);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      // Act
      const result = await executeExternalCall(makeStep(), makeCtx());

      // Assert: the cached result is returned AND fetch was never called
      // (regression: if cache lookup is removed or short-circuit is broken,
      //  fetch will be called and this assertion fails clearly)
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toEqual(cachedResult);
    });

    it('cache hit logs info with stepId before returning', async () => {
      // Arrange
      vi.mocked(lookupDispatch).mockResolvedValueOnce(cachedResult);
      const ctx = makeCtx();

      // Act
      await executeExternalCall(makeStep(), ctx);

      // Assert: the ctx.logger.info was called with the cache-hit message
      // (regression: if logging is removed after the cache check, this fails)
      expect(ctx.logger.info).toHaveBeenCalledWith(
        'external_call: dispatch cache hit, skipping HTTP request',
        { stepId: 'ext1' }
      );
      expect(ctx.logger.info).toHaveBeenCalledTimes(1);
    });

    it('cache miss fires HTTP then calls recordDispatch with correct args', async () => {
      // Arrange: cache returns null (default), HTTP returns 200
      vi.mocked(lookupDispatch).mockResolvedValueOnce(null);
      const responseBody = { ok: true };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      // Act
      const result = await executeExternalCall(makeStep(), makeCtx());

      // Assert: recordDispatch is called with the deterministic cache key and
      // the step's result. This verifies the executor actually writes to the
      // cache after a successful call — not just that it passes mock data through.
      expect(vi.mocked(recordDispatch)).toHaveBeenCalledWith({
        executionId: 'exec_1',
        stepId: 'ext1',
        idempotencyKey: 'exec_1:ext1',
        result: expect.objectContaining({ output: { status: 200, body: responseBody } }),
      });
      expect(result).toMatchObject({ output: { status: 200, body: responseBody } });
    });

    it('buildIdempotencyKey called with executionId and stepId (no turnIndex)', async () => {
      // Arrange: cache miss so the full flow runs
      vi.mocked(lookupDispatch).mockResolvedValueOnce(null);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      // Act
      await executeExternalCall(makeStep(), makeCtx());

      // Assert: the key builder is called without turnIndex — external_call is
      // a single-shot step, not multi-turn. Regression: if someone adds turnIndex
      // to the external_call invocation, the cache key changes and old cached
      // results are missed.
      expect(vi.mocked(buildIdempotencyKey)).toHaveBeenCalledWith({
        executionId: 'exec_1',
        stepId: 'ext1',
      });
      // Verify it was NOT called with turnIndex
      const calls = vi.mocked(buildIdempotencyKey).mock.calls;
      expect(calls[0]?.[0]).not.toHaveProperty('turnIndex');
    });

    it('author omits idempotencyKey → fetch receives Idempotency-Key header equal to cache key', async () => {
      // Arrange: no idempotencyKey in config; cache miss
      vi.mocked(lookupDispatch).mockResolvedValueOnce(null);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );

      // Act: step has no idempotencyKey config (default makeStep has none)
      await executeExternalCall(makeStep(), makeCtx());

      // Assert: auto-derived idempotency key (== cache key) is forwarded to fetch
      // Regression: if the default-to-cache-key path is removed, the header
      // will be absent and this objectContaining check will fail.
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('exec_1:ext1');
    });

    it('author supplies literal idempotencyKey → header uses verbatim value, not cache key', async () => {
      // Arrange: author set a literal key
      vi.mocked(lookupDispatch).mockResolvedValueOnce(null);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );

      // Act
      await executeExternalCall(makeStep({ idempotencyKey: 'my-static-key' }), makeCtx());

      // Assert: the author-supplied literal takes precedence over the cache key.
      // Regression: if the override path is broken, the header will be 'exec_1:ext1'
      // instead of 'my-static-key', and this toBe check will fail.
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('my-static-key');
    });

    it('author supplies idempotencyKey: "auto" → header forwarded as "auto" (HTTP layer mints UUID)', async () => {
      // Arrange: author set 'auto'; HTTP layer (resolveIdempotencyHeader) converts
      // 'auto' to a UUID — we assert the executor does NOT replace 'auto' with
      // the cache key before handing off to the HTTP layer.
      vi.mocked(lookupDispatch).mockResolvedValueOnce(null);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        );

      // Act
      await executeExternalCall(makeStep({ idempotencyKey: 'auto' }), makeCtx());

      // Assert: the UUID-minted header is a UUID string, not the cache key or literal 'auto'.
      // (resolveIdempotencyHeader converts 'auto' → randomUUID() inside the HTTP layer)
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const headerValue = headers['Idempotency-Key'];
      // UUID pattern: 8-4-4-4-12 hex
      expect(headerValue).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(headerValue).not.toBe('exec_1:ext1');
      expect(headerValue).not.toBe('auto');
    });

    it('recordDispatch race-loss (returns false) → step returns its result normally, no warn', async () => {
      // Arrange: cache miss, HTTP success, but recordDispatch lost the race
      vi.mocked(lookupDispatch).mockResolvedValueOnce(null);
      vi.mocked(recordDispatch).mockResolvedValueOnce(false);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = makeCtx();

      // Act: must not throw
      const result = await executeExternalCall(makeStep(), ctx);

      // Assert: result is returned normally even though we lost the cache race
      // Regression: if a race-loss return value of false causes a throw, this fails
      expect(result).toMatchObject({ output: { status: 200 } });
      // ctx.logger.warn must NOT be called — false is a race loss, not an error
      expect(ctx.logger.warn).not.toHaveBeenCalled();
    });

    it('recordDispatch throws non-P2002 → ctx.logger.warn called, step still returns result', async () => {
      // Arrange: cache miss, HTTP success, recordDispatch throws a generic error
      vi.mocked(lookupDispatch).mockResolvedValueOnce(null);
      const dbError = new Error('connection timeout');
      vi.mocked(recordDispatch).mockRejectedValueOnce(dbError);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = makeCtx();

      // Act: must not throw — the DB error is non-fatal
      const result = await executeExternalCall(makeStep(), ctx);

      // Assert: result is returned and the warn log includes the error message
      // Regression: if the outer try/catch around recordDispatch is removed,
      // the DB error propagates and this resolves check fails
      expect(result).toMatchObject({ output: { status: 200 } });
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        'external_call: failed to record dispatch; re-drive may re-fire',
        { stepId: 'ext1', error: 'connection timeout' }
      );
    });

    it('cache miss → HTTP throws → recordDispatch NOT called (no caching of failures)', async () => {
      // Arrange: cache miss, then HTTP request returns a 400 status (treated as
      // ExecutorError by the source's HTTP failure path)
      vi.mocked(lookupDispatch).mockResolvedValueOnce(null);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('{"error":"bad request"}', {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      // Act: the source should throw an ExecutorError for the 400 response
      await expect(executeExternalCall(makeStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
      });

      // Assert: no successful result to cache — recordDispatch must NOT have been called
      // Regression: if recordDispatch is moved before the HTTP-error check, it would
      // fire here and cache a partial/wrong result.
      expect(vi.mocked(recordDispatch)).not.toHaveBeenCalled();
    });

    it('cache hit short-circuits BEFORE config validation (proves lookup is the first operation)', async () => {
      // Arrange: cache hit + deliberately invalid config (empty URL)
      // If the lookup came AFTER config validation, this would throw 'missing_url'.
      // The cache hit must be the very first async operation in executeExternalCall.
      vi.mocked(lookupDispatch).mockResolvedValueOnce(cachedResult);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      // Step has an invalid URL that would normally throw ExecutorError('missing_url')
      const stepWithBadUrl = makeStep({ url: '' });

      // Act
      const result = await executeExternalCall(stepWithBadUrl, makeCtx());

      // Assert: no throw, cached result returned, fetch never called
      // Regression: if cache lookup is moved to after schema/url validation,
      // this will throw ExecutorError('missing_url') instead of returning cachedResult
      expect(result).toEqual(cachedResult);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
