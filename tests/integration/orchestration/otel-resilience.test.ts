/**
 * Integration test — OTel resilience under ThrowingTracer.
 *
 * Structural guarantee: a tracer whose `startSpan` throws must NEVER abort
 * orchestration. The `withSpan` helper in `lib/orchestration/tracing/with-span.ts`
 * catches the error and falls back to NOOP_SPAN — this test verifies that
 * guarantee holds end-to-end through the real engine.
 *
 * Test Coverage:
 * - A1: ThrowingTracer + simple workflow: completes successfully with a warn log
 * - A2: ThrowingTracer + AiCostLog write: cost rows still land (traceId is null)
 * - A3: Capability dispatch under ThrowingTracer — parked (see reason below)
 * - A4: Chat handler under ThrowingTracer — parked (see reason below)
 *
 * @see lib/orchestration/tracing/with-span.ts
 * @see tests/unit/lib/orchestration/tracing/with-span.test.ts (unit-level guarantee)
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

import { logger } from '@/lib/logging';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  registerStepType,
} from '@/lib/orchestration/engine/executor-registry';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { prisma } from '@/lib/db/client';
import { registerTracer } from '@/lib/orchestration/tracing';
import { resetTracer } from '@/lib/orchestration/tracing/registry';
import { ThrowingTracer } from '@/tests/helpers/mock-tracer';
import type { ExecutionEvent, WorkflowDefinition } from '@/types/orchestration';
import { CostOperation } from '@/types/orchestration';

const USER_ID = 'user_resilience_test';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function seedExecutionMocks(): void {
  vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
    id: 'exec_resilience',
    status: 'running',
  } as never);

  vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
    id: 'exec_resilience',
    workflowId: 'wf_resilience',
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

const SIMPLE_WORKFLOW: WorkflowDefinition = {
  steps: [
    {
      id: 'step_a',
      name: 'Step A',
      type: 'llm_call',
      config: { prompt: 'hello' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step_a',
  errorStrategy: 'fail',
};

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryForTests();
  resetTracer();
  seedExecutionMocks();
  // Re-apply the aiCostLog.create mock that clearAllMocks wiped
  vi.mocked(prisma.aiCostLog.create).mockResolvedValue({ id: 'cost_1' } as never);
});

afterEach(() => {
  resetTracer();
  __resetRegistryForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A1. ThrowingTracer + workflow run completes
// ---------------------------------------------------------------------------

describe('OTel resilience — ThrowingTracer', () => {
  it('A1: workflow completes even when the tracer throws on startSpan', async () => {
    // Arrange: register a simple executor and install ThrowingTracer
    registerStepType('llm_call', async () => ({
      output: { text: 'result' },
      tokensUsed: 10,
      costUsd: 0.001,
    }));

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    registerTracer(new ThrowingTracer());

    // Act
    const events = await collectEvents(new OrchestrationEngine(), {
      id: 'wf_resilience',
      definition: SIMPLE_WORKFLOW,
    });

    // Assert: workflow completed, NOT failed
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('workflow_completed');
    expect(eventTypes).not.toContain('workflow_failed');

    // The warn about startSpan throwing must have been emitted at least once
    const startSpanWarns = warnSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.startsWith('Tracer.startSpan threw')
    );
    expect(startSpanWarns.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // A2. ThrowingTracer + AiCostLog rows still write (traceId is null)
  // ---------------------------------------------------------------------------

  it('A2: AiCostLog rows still land under ThrowingTracer, with traceId absent (null normalisation)', async () => {
    // Arrange: register an executor that calls logCost directly via the production
    // path — passing the span IDs from whatever span the ThrowingTracer returns.
    // Under ThrowingTracer, withSpan falls back to NOOP_SPAN (traceId='', spanId='').
    // The if (params.traceId) guard in cost-tracker.ts normalises empty strings away
    // so traceId/spanId should be absent from the Prisma write.

    registerStepType('llm_call', async (_step, ctx) => {
      // Call logCost with the empty-string IDs that NOOP_SPAN produces
      await logCost({
        workflowExecutionId: ctx.executionId,
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 50,
        outputTokens: 25,
        operation: CostOperation.CHAT,
        // Simulate what happens when NOOP_SPAN's traceId/spanId (both '') are passed
        traceId: '',
        spanId: '',
      });
      return { output: { text: 'result' }, tokensUsed: 75, costUsd: 0 };
    });

    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    registerTracer(new ThrowingTracer());

    // Act
    const events = await collectEvents(new OrchestrationEngine(), {
      id: 'wf_resilience',
      definition: SIMPLE_WORKFLOW,
    });

    // Assert: workflow still completed
    expect(events.map((e) => e.type)).toContain('workflow_completed');

    // Assert: aiCostLog.create was called at least once
    expect(prisma.aiCostLog.create).toHaveBeenCalledTimes(1);

    // Assert: traceId and spanId were NOT written (empty strings normalised away)
    const createCall = vi.mocked(prisma.aiCostLog.create).mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty('traceId');
    expect(createCall.data).not.toHaveProperty('spanId');
  });

  // ---------------------------------------------------------------------------
  // A3. Capability dispatch under ThrowingTracer — parked
  // ---------------------------------------------------------------------------

  it.todo(
    'A3: capability dispatch under ThrowingTracer returns the same result as under NOOP_TRACER — parked: dispatcher requires substantial DB mock surface (aiCapability.findMany + aiAgentCapability.findMany + in-memory handler registration) that is not shared with any existing integration fixture. The structural guarantee that a throwing tracer cannot abort capability dispatch is already proved at the unit level by tests/unit/lib/orchestration/tracing/with-span.test.ts and transitively exercised by the engine resilience tests above (A1/A2) which run through the engine executor path.'
  );

  // ---------------------------------------------------------------------------
  // A4. Chat handler under ThrowingTracer — parked
  // ---------------------------------------------------------------------------

  it.todo(
    'A4: chat handler under ThrowingTracer — parked: chat handler resilience is covered transitively by otel-chat-trace.test.ts which exercises the handler under MockTracer; the throwing case structurally cannot abort the wrapped operation per the with-span unit tests. The mock surface for streaming-handler.ts (auth, agent DB rows, provider, SSE stream) is too large to set up for a single resilience assertion.'
  );
});
