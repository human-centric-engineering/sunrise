/**
 * Integration test — AiCostLog traceId/spanId correlation end-to-end.
 *
 * Phase 3 of the OTEL branch added `traceId` and `spanId` columns to
 * `AiCostLog` and threaded span IDs from the active tracer through
 * `runLlmCall → logCost`. This test verifies that:
 *
 *   B1: When a real tracer is registered, the logged row carries the
 *       span's deterministic IDs (traceId = 'trace-1', spanId matching
 *       the 'llm.call' span).
 *
 *   B2: Chat single-turn traceId/spanId correlation — parked (see below).
 *
 *   B3: Tool-call chat two-row traceId sharing — parked (see below).
 *
 *   B4: Under the NOOP_TRACER (default / after resetTracer()), traceId
 *       and spanId are absent from the Prisma write (empty-string
 *       normalisation in cost-tracker.ts:148-149 filters them out).
 *
 * @see lib/orchestration/llm/cost-tracker.ts  (logCost — normalisation guard)
 * @see lib/orchestration/engine/llm-runner.ts  (runLlmCall — span ID threading)
 * @see tests/helpers/mock-tracer.ts            (MockTracer)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    aiCostLog: { create: vi.fn().mockResolvedValue({ id: 'cost_1' }) },
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

// Mock provider-manager so runLlmCall never tries to reach a real LLM
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));

// Mock settings-resolver so runLlmCall resolves a model without hitting the DB
vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn().mockResolvedValue('gpt-4o-mini'),
  invalidateSettingsCache: vi.fn(),
  __resetSettingsResolverForTests: vi.fn(),
}));

import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  registerStepType,
} from '@/lib/orchestration/engine/executor-registry';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { prisma } from '@/lib/db/client';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { registerTracer, SPAN_LLM_CALL } from '@/lib/orchestration/tracing';
import { resetTracer } from '@/lib/orchestration/tracing/registry';
import { findSpan, MockTracer } from '@/tests/helpers/mock-tracer';
import type { ExecutionEvent, WorkflowDefinition } from '@/types/orchestration';

const USER_ID = 'user_correlation_test';

// ---------------------------------------------------------------------------
// Mock provider factory
// ---------------------------------------------------------------------------

function makeMockProvider() {
  return {
    chat: vi.fn().mockResolvedValue({
      content: 'mock response',
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  };
}

// ---------------------------------------------------------------------------
// Shared engine setup helpers
// ---------------------------------------------------------------------------

function seedExecutionMocks(): void {
  vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
    id: 'exec_correlation',
    status: 'running',
  } as never);

  vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
    id: 'exec_correlation',
    workflowId: 'wf_correlation',
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
}

async function collectEvents(
  engine: OrchestrationEngine,
  workflow: { id: string; definition: WorkflowDefinition }
): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of engine.execute(workflow as never, {}, { userId: USER_ID })) {
    events.push(event);
  }
  return events;
}

/** Minimal single-step llm_call workflow. */
const SINGLE_LLM_WORKFLOW: WorkflowDefinition = {
  steps: [
    {
      id: 'step_llm',
      name: 'LLM step',
      type: 'llm_call',
      config: { prompt: 'hello', modelOverride: 'gpt-4o-mini' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step_llm',
  errorStrategy: 'fail',
};

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tracer: MockTracer;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryForTests();
  resetTracer();

  tracer = new MockTracer();

  seedExecutionMocks();
  // Re-apply the aiCostLog.create mock that clearAllMocks wiped
  vi.mocked(prisma.aiCostLog.create).mockResolvedValue({ id: 'cost_1' } as never);

  // Reset the provider mock to a fresh implementation
  vi.mocked(getProvider).mockResolvedValue(makeMockProvider() as never);
});

afterEach(() => {
  resetTracer();
  tracer.reset();
  __resetRegistryForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// B1. MockTracer: AiCostLog has matching traceId/spanId
// ---------------------------------------------------------------------------

describe('AiCostLog trace correlation — MockTracer', () => {
  it('B1: logCost row carries traceId=trace-1 and spanId matching the llm.call span', async () => {
    // Arrange: register an executor that exercises the production runLlmCall path
    registerStepType('llm_call', async (step, ctx) => {
      const result = await runLlmCall(ctx, {
        stepId: step.id,
        prompt: (step.config as { prompt: string }).prompt,
        modelOverride: (step.config as { modelOverride?: string }).modelOverride,
      });
      return {
        output: { text: result.content },
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
      };
    });

    // Register MockTracer BEFORE running so withSpan picks it up
    registerTracer(tracer);

    // Act: run the workflow — fire-and-forget logCost is spawned inside runLlmCall
    const events = await collectEvents(new OrchestrationEngine(), {
      id: 'wf_correlation',
      definition: SINGLE_LLM_WORKFLOW,
    });

    // Allow any pending microtasks (Promise resolution) to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert: workflow completed
    expect(events.map((e) => e.type)).toContain('workflow_completed');

    // Assert: aiCostLog.create was called exactly once
    expect(prisma.aiCostLog.create).toHaveBeenCalledTimes(1);

    // Assert: the logged row's traceId is 'trace-1' (MockTracer's deterministic root ID)
    const createArgs = vi.mocked(prisma.aiCostLog.create).mock.calls[0][0];
    expect(createArgs.data.traceId).toBe('trace-1');

    // Assert: spanId matches the actual llm.call span recorded by MockTracer
    const llmSpan = findSpan(tracer.spans, SPAN_LLM_CALL);
    expect(createArgs.data.spanId).toBe(llmSpan.spanId);
  });
});

// ---------------------------------------------------------------------------
// B2. Chat single-turn traceId/spanId — parked
// ---------------------------------------------------------------------------

describe('AiCostLog trace correlation — chat handler', () => {
  it.todo(
    'B2: chat single-turn: traceId/spanId on the AiCostLog row matches the successful llm.call span — parked: streaming-handler.ts requires extensive mock surface (better-auth session, aiAgent DB row, provider config, ReadableStream + SSE infrastructure) that is impractical for a single span-correlation assertion. The lifting-into-outer-scope at streaming-handler.ts:463-470 is structurally verified: llmTraceId/llmSpanId are assigned inside the success path of the try{} block and passed to logCost only on successful completion.'
  );

  it.todo(
    'B3: tool-call chat: two AiCostLog rows share the same traceId (both children of chat.turn span) — parked: depends on B2 chat mock surface; impractical without full streaming-handler test harness.'
  );
});

// ---------------------------------------------------------------------------
// B4. NOOP_TRACER (default): traceId/spanId are absent from the write
// ---------------------------------------------------------------------------

describe('AiCostLog trace correlation — NOOP_TRACER (default)', () => {
  it('B4: without a registered tracer, traceId and spanId are absent from the AiCostLog row', async () => {
    // Arrange: no registerTracer call — NOOP_TRACER is the default after resetTracer()
    // NOOP_SPAN.traceId() and .spanId() return '' — the if (params.traceId) guard
    // in cost-tracker.ts:148-149 filters empty strings away before the Prisma write.

    registerStepType('llm_call', async (step, ctx) => {
      const result = await runLlmCall(ctx, {
        stepId: step.id,
        prompt: (step.config as { prompt: string }).prompt,
        modelOverride: (step.config as { modelOverride?: string }).modelOverride,
      });
      return {
        output: { text: result.content },
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
      };
    });

    // Act: run WITHOUT registering any tracer — NOOP_TRACER remains active
    const events = await collectEvents(new OrchestrationEngine(), {
      id: 'wf_correlation',
      definition: SINGLE_LLM_WORKFLOW,
    });

    // Allow fire-and-forget logCost microtasks to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert: workflow completed
    expect(events.map((e) => e.type)).toContain('workflow_completed');

    // Assert: aiCostLog.create was called (cost logging is not disabled by default tracer)
    expect(prisma.aiCostLog.create).toHaveBeenCalledTimes(1);

    // Assert: traceId and spanId are NOT in the write — empty-string normalisation succeeded
    const createArgs = vi.mocked(prisma.aiCostLog.create).mock.calls[0][0];
    expect(createArgs.data).not.toHaveProperty('traceId');
    expect(createArgs.data).not.toHaveProperty('spanId');
  });
});
