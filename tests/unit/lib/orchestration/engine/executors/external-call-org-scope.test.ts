/**
 * Tests: a workflow's external_call step names only its org's env vars (§111 t-811)
 *
 * An org admin authors workflows now, so a step's `${env:NAME}` URL or header
 * template, and its `authSecret` name, must not reach the operator's env vars
 * when the workflow runs in a customer org. The rule is in
 * `lib/orchestration/env-template.ts`; this is the step reporting it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, TENANCY_MODE: 'multi' } };
});
vi.mock('@/lib/orchestration/engine/executor-registry', () => ({ registerStepType: vi.fn() }));
vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  interpolatePrompt: vi.fn((template: string) => template),
}));
vi.mock('@/lib/logging', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, withContext: vi.fn(() => log) } };
});
vi.mock('@/lib/orchestration/engine/dispatch-cache', () => ({
  buildIdempotencyKey: vi.fn(() => 'key'),
  lookupDispatch: vi.fn().mockResolvedValue(null),
  recordDispatch: vi.fn().mockResolvedValue(true),
}));

import { executeExternalCall } from '@/lib/orchestration/engine/executors/external-call';
import { resetAllowlistCache } from '@/lib/orchestration/http/allowlist';
import { resetOutboundRateLimiters } from '@/lib/orchestration/engine/outbound-rate-limiter';
import { orgEnvVarPrefix } from '@/lib/orchestration/env-template';
import { runAsOrg } from '@/lib/tenancy/context';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

const ORG_B = 'cmorg0000000000000000orgb';
const PLATFORM_SECRET = 'T811_STEP_PLATFORM_SECRET';
const B_PATH = `${orgEnvVarPrefix(ORG_B)}PATH`;

function ctx(): ExecutionContext {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: {},
    stepOutputs: {},
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: { ...log, withContext: vi.fn().mockReturnThis() },
  } as unknown as ExecutionContext;
}

function step(config: Record<string, unknown>): WorkflowStep {
  return {
    id: 'ext1',
    name: 'call',
    type: 'external_call',
    config: { url: 'https://api.allowed.com/v1', method: 'POST', timeoutMs: 5000, ...config },
    nextSteps: [],
  };
}

beforeEach(() => {
  process.env.ORCHESTRATION_ALLOWED_HOSTS = 'api.allowed.com';
  process.env[PLATFORM_SECRET] = 'operator-value';
  process.env[B_PATH] = 'v1/notify';
  resetAllowlistCache();
  resetOutboundRateLimiters();
});

afterEach(() => {
  delete process.env.ORCHESTRATION_ALLOWED_HOSTS;
  delete process.env[PLATFORM_SECRET];
  delete process.env[B_PATH];
  resetAllowlistCache();
  vi.restoreAllMocks();
});

const inB = <T>(fn: () => Promise<T>) => runAsOrg(ORG_B, fn);

describe('external_call in a customer org at multi', () => {
  it('refuses a URL template naming the operator’s variable, and sends nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const run = inB(() =>
      executeExternalCall(
        step({ url: `https://api.allowed.com/\${env:${PLATFORM_SECRET}}` }),
        ctx()
      )
    );

    await expect(run).rejects.toMatchObject({ code: 'env_var_not_available' });
    await expect(run).rejects.not.toThrow(/operator-value/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an auth secret naming the operator’s variable, and sends nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const run = inB(() =>
      executeExternalCall(step({ authType: 'bearer', authSecret: PLATFORM_SECRET }), ctx())
    );

    await expect(run).rejects.toMatchObject({ code: 'env_var_not_available' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves a template under its own prefix', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

    await inB(() =>
      executeExternalCall(step({ url: `https://api.allowed.com/\${env:${B_PATH}}` }), ctx())
    );

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.allowed.com/v1/notify');
  });
});
