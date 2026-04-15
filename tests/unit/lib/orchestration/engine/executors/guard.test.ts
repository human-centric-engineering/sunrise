/**
 * Tests for `lib/orchestration/engine/executors/guard.ts`.
 *
 * Covers:
 *   - Happy path LLM mode: PASS and FAIL responses routed correctly.
 *   - Regex mode: matching and non-matching input.
 *   - Missing rules → ExecutorError('missing_rules').
 *   - Invalid regex → ExecutorError('invalid_regex').
 *   - Flag mode: failure continues to pass edge.
 *   - Case-insensitive verdict parsing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  runLlmCall: vi.fn(),
  interpolatePrompt: vi.fn((template: string) => template),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeGuard } from '@/lib/orchestration/engine/executors/guard';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { message: 'Hello world' },
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

function makeGuardStep(overrides?: Partial<WorkflowStep['config']>): WorkflowStep {
  return {
    id: 'guard1',
    name: 'Test Guard',
    type: 'guard',
    config: {
      rules: 'No personal information allowed',
      mode: 'llm',
      failAction: 'block',
      ...overrides,
    },
    nextSteps: [
      { targetStepId: 'pass-step', condition: 'pass' },
      { targetStepId: 'fail-step', condition: 'fail' },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('LLM mode: routes to pass edge when model returns PASS', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'PASS\nInput is safe.',
      tokensUsed: 10,
      costUsd: 0.01,
      model: 'm',
    });

    const result = await executeGuard(makeGuardStep(), makeCtx());

    expect(result).toMatchObject({
      output: { passed: true, verdict: 'pass' },
      nextStepIds: ['pass-step'],
      tokensUsed: 10,
      costUsd: 0.01,
    });
  });

  it('LLM mode: routes to fail edge when model returns FAIL', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'FAIL\nContains PII.',
      tokensUsed: 8,
      costUsd: 0.008,
      model: 'm',
    });

    const result = await executeGuard(makeGuardStep(), makeCtx());

    expect(result).toMatchObject({
      output: { passed: false, verdict: 'fail' },
      nextStepIds: ['fail-step'],
    });
  });

  it('LLM mode: case-insensitive verdict parsing', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'pass\nLooks good.',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const result = await executeGuard(makeGuardStep(), makeCtx());
    expect(result.output).toMatchObject({ passed: true });
  });

  it('regex mode: passes when input matches pattern', async () => {
    const step = makeGuardStep({ mode: 'regex', rules: 'Hello' });
    const result = await executeGuard(step, makeCtx());

    expect(result).toMatchObject({
      output: { passed: true, verdict: 'pass' },
      nextStepIds: ['pass-step'],
      tokensUsed: 0,
      costUsd: 0,
    });
  });

  it('regex mode: fails when input does not match pattern', async () => {
    const step = makeGuardStep({ mode: 'regex', rules: 'FORBIDDEN_WORD' });
    const result = await executeGuard(step, makeCtx());

    expect(result).toMatchObject({
      output: { passed: false, verdict: 'fail' },
      nextStepIds: ['fail-step'],
    });
  });

  it('regex mode: throws on invalid regex', async () => {
    const step = makeGuardStep({ mode: 'regex', rules: '[invalid(' });

    await expect(executeGuard(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'invalid_regex',
    });
  });

  it('flag mode: routes to pass edge even on failure', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'FAIL\nFlagged issue.',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const step = makeGuardStep({ failAction: 'flag' });
    const result = await executeGuard(step, makeCtx());

    expect(result.output).toMatchObject({ passed: false, failAction: 'flag' });
    expect(result.nextStepIds).toEqual(['pass-step']);
  });

  it('throws ExecutorError with code "missing_rules" when rules is empty', async () => {
    const step = makeGuardStep({ rules: '' });

    await expect(executeGuard(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_rules',
    });
  });

  it('throws ExecutorError with code "missing_rules" when rules is absent', async () => {
    const step = makeGuardStep({ rules: undefined });

    await expect(executeGuard(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_rules',
    });
  });
});
