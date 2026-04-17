/**
 * Tests for `lib/orchestration/engine/executors/external-call.ts`.
 *
 * Covers:
 *   - Happy path: successful HTTP call returns parsed JSON body.
 *   - Missing URL → ExecutorError('missing_url').
 *   - Host not in allowlist → ExecutorError('host_not_allowed').
 *   - Non-2xx response → ExecutorError('http_error').
 *   - Request timeout → ExecutorError('request_failed').
 *   - Auth header resolution (bearer, api-key).
 *   - GET requests omit body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  interpolatePrompt: vi.fn((template: string) => template),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeExternalCall } from '@/lib/orchestration/engine/executors/external-call';
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

function makeExternalCallStep(overrides?: Partial<WorkflowStep['config']>): WorkflowStep {
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
    process.env = {
      ...originalEnv,
      ORCHESTRATION_ALLOWED_HOSTS: 'api.allowed.com,other.allowed.com',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('happy path: returns parsed JSON response', async () => {
    const mockResponse = { result: 'success' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await executeExternalCall(makeExternalCallStep(), makeCtx());

    expect(result).toMatchObject({
      output: { status: 200, body: mockResponse },
      tokensUsed: 0,
      costUsd: 0,
    });
  });

  it('throws ExecutorError with code "missing_url" when URL is empty', async () => {
    const step = makeExternalCallStep({ url: '' });

    await expect(executeExternalCall(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_url',
    });
  });

  it('throws ExecutorError with code "missing_url" when URL is absent', async () => {
    const step = makeExternalCallStep({ url: undefined });

    await expect(executeExternalCall(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_url',
    });
  });

  it('throws ExecutorError with code "host_not_allowed" for non-allowlisted host', async () => {
    const step = makeExternalCallStep({ url: 'https://evil.com/attack' });

    await expect(executeExternalCall(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'host_not_allowed',
    });
  });

  it('throws ExecutorError with code "host_not_allowed" when allowlist is empty', async () => {
    process.env.ORCHESTRATION_ALLOWED_HOSTS = '';
    const step = makeExternalCallStep();

    await expect(executeExternalCall(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'host_not_allowed',
    });
  });

  it('throws ExecutorError with code "http_error" for non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));

    await expect(executeExternalCall(makeExternalCallStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'http_error',
    });
  });

  it('throws ExecutorError with code "request_failed" on fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    await expect(executeExternalCall(makeExternalCallStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'request_failed',
    });
  });

  it('includes bearer auth header when configured', async () => {
    process.env.MY_TOKEN = 'secret123';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const step = makeExternalCallStep({
      authType: 'bearer',
      authSecret: 'MY_TOKEN',
    });

    await executeExternalCall(step, makeCtx());

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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const step = makeExternalCallStep({
      authType: 'api-key',
      authSecret: 'MY_API_KEY',
    });

    await executeExternalCall(step, makeCtx());

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'key456',
        }),
      })
    );
  });

  it('omits body for GET requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const step = makeExternalCallStep({ method: 'GET', bodyTemplate: '{"ignored": true}' });
    await executeExternalCall(step, makeCtx());

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'GET',
        body: undefined,
      })
    );
  });
});
