/**
 * Integration test — engine trace capture round-trips through the real
 * `executionTraceSchema`.
 *
 * The unit tests for the engine assert the shape written to the prisma
 * mock; this test additionally proves the persisted shape parses cleanly
 * via the actual Zod schema (so a malformed `.optional()` annotation in
 * the schema would be caught here even if a unit test happened to drift).
 *
 * Three scenarios:
 *   1. Sequential workflow with mixed LLM-bearing and non-LLM steps —
 *      asserts `input` is captured for every step, `model` / `provider` /
 *      tokens / `llmDurationMs` only on steps that pushed telemetry.
 *   2. Parallel branches — asserts per-step telemetry isolation when
 *      branches run concurrently.
 *   3. Failed step with retry-then-success — asserts only the successful
 *      attempt's telemetry survives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
  },
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  registerStepType,
} from '@/lib/orchestration/engine/executor-registry';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { executionTraceSchema } from '@/lib/validations/orchestration';
import { prisma } from '@/lib/db/client';
import type { ExecutionEvent, WorkflowDefinition } from '@/types/orchestration';

const USER_ID = 'user_test';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryForTests();

  vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
    id: 'exec_test',
    status: 'running',
  } as never);

  vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
    id: 'exec_test',
    workflowId: 'wf_test',
    userId: USER_ID,
    status: 'running',
    inputData: {},
    executionTrace: [],
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    budgetLimitUsd: null,
    currentStep: null,
    startedAt: new Date(),
    completedAt: null,
    outputData: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);

  vi.mocked(prisma.aiWorkflowExecution.update).mockImplementation((async (args: unknown) => {
    const { where, data } = args as { where: { id: string }; data: Record<string, unknown> };
    return { id: where.id, ...data };
  }) as never);
});

afterEach(() => {
  __resetRegistryForTests();
});

async function collect(
  engine: OrchestrationEngine,
  workflow: { id: string; definition: WorkflowDefinition }
): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of engine.execute(workflow as never, {}, { userId: USER_ID })) {
    events.push(event);
  }
  return events;
}

function lastWrittenRawTrace(): unknown {
  const calls = vi.mocked(prisma.aiWorkflowExecution.update).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const args = calls[i][0] as { data?: { executionTrace?: unknown } };
    if (Array.isArray(args.data?.executionTrace)) {
      return args.data.executionTrace;
    }
  }
  return [];
}

describe('engine trace capture — schema round-trip integration', () => {
  it('sequential workflow: persisted trace parses cleanly and carries new optional fields', async () => {
    // LLM step pushes telemetry; tool step does not (non-LLM).
    registerStepType('llm_call', async (_step, ctx) => {
      ctx.stepTelemetry?.push({
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 200,
      });
      return { output: { text: 'hello' }, tokensUsed: 150, costUsd: 0.05 };
    });
    registerStepType('tool_call', async () => ({
      output: { tool: 'result' },
      tokensUsed: 0,
      costUsd: 0,
    }));

    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'LLM step',
          type: 'llm_call',
          config: { prompt: 'hello' },
          nextSteps: [{ targetStepId: 'b' }],
        },
        {
          id: 'b',
          name: 'Tool step',
          type: 'tool_call',
          config: { capabilitySlug: 'lookup' },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    await collect(new OrchestrationEngine(), { id: 'wf_test', definition: def });

    const raw = lastWrittenRawTrace();
    const parsed = executionTraceSchema.parse(raw);
    expect(parsed).toHaveLength(2);

    // LLM step has all the new fields.
    expect(parsed[0].stepId).toBe('a');
    expect(parsed[0].input).toEqual({ prompt: 'hello' });
    expect(parsed[0].model).toBe('gpt-4o-mini');
    expect(parsed[0].provider).toBe('openai');
    expect(parsed[0].inputTokens).toBe(100);
    expect(parsed[0].outputTokens).toBe(50);
    expect(parsed[0].llmDurationMs).toBe(200);

    // Non-LLM step has only `input`; LLM-specific fields are absent.
    expect(parsed[1].stepId).toBe('b');
    expect(parsed[1].input).toEqual({ capabilitySlug: 'lookup' });
    expect(parsed[1].model).toBeUndefined();
    expect(parsed[1].provider).toBeUndefined();
    expect(parsed[1].inputTokens).toBeUndefined();
    expect(parsed[1].outputTokens).toBeUndefined();
    expect(parsed[1].llmDurationMs).toBeUndefined();
  });

  it('parallel branches: telemetry stays isolated and round-trips through the schema', async () => {
    registerStepType('parallel', async () => ({
      output: { fanout: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step, ctx) => {
      // Each branch pushes a distinct entry. If isolation is broken,
      // the schema parse would still pass but the per-step assertions
      // below would catch the bleed.
      ctx.stepTelemetry?.push({
        model: `model-${step.id}`,
        provider: `provider-${step.id}`,
        inputTokens: 30,
        outputTokens: 10,
        durationMs: 75,
      });
      return { output: `out:${step.id}`, tokensUsed: 40, costUsd: 0.02 };
    });

    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'p',
          name: 'Parallel',
          type: 'parallel',
          config: {},
          nextSteps: [{ targetStepId: 'a' }, { targetStepId: 'b' }],
        },
        { id: 'a', name: 'A', type: 'llm_call', config: { prompt: 'A' }, nextSteps: [] },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    await collect(new OrchestrationEngine(), { id: 'wf_test', definition: def });

    const parsed = executionTraceSchema.parse(lastWrittenRawTrace());
    const aEntry = parsed.find((e) => e.stepId === 'a');
    const bEntry = parsed.find((e) => e.stepId === 'b');
    expect(aEntry?.model).toBe('model-a');
    expect(aEntry?.provider).toBe('provider-a');
    expect(aEntry?.inputTokens).toBe(30);
    expect(bEntry?.model).toBe('model-b');
    expect(bEntry?.provider).toBe('provider-b');
    expect(bEntry?.inputTokens).toBe(30);
  });

  it('retry success: failed-attempt telemetry is preserved (summed) — model still from last attempt', async () => {
    let attempts = 0;
    registerStepType('llm_call', async (_step, ctx) => {
      attempts++;
      ctx.stepTelemetry?.push({
        model: `model-${attempts}`,
        provider: 'openai',
        inputTokens: attempts * 10,
        outputTokens: attempts * 5,
        durationMs: attempts * 100,
      });
      if (attempts === 1) {
        throw new ExecutorError('a', 'transient', 'simulated transient failure', undefined, true);
      }
      return { output: 'ok', tokensUsed: 30, costUsd: 0.01 };
    });

    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A', errorStrategy: 'retry', retryCount: 1 },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    await collect(new OrchestrationEngine(), { id: 'wf_test', definition: def });

    const parsed = executionTraceSchema.parse(lastWrittenRawTrace());
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe('completed');
    // Model + provider come from the LAST telemetry entry (successful attempt).
    expect(parsed[0].model).toBe('model-2');
    expect(parsed[0].provider).toBe('openai');
    // Tokens / duration sum across both attempts (10+20, 5+10, 100+200) so
    // the trace header aligns with the AiCostLog-derived per-call sub-table.
    expect(parsed[0].inputTokens).toBe(30);
    expect(parsed[0].outputTokens).toBe(15);
    expect(parsed[0].llmDurationMs).toBe(300);
  });
});
