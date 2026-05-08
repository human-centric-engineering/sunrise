/**
 * Tests for per-step timeout and non-retriable error handling in the
 * orchestration engine.
 *
 * Covers:
 *   - Step timeout fires and produces ExecutorError('step_timeout').
 *   - Non-retriable errors skip retry attempts.
 *   - Retriable errors still retry normally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
    },
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  registerStepType,
} from '@/lib/orchestration/engine/executor-registry';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { prisma } from '@/lib/db/client';
import type { ExecutionEvent, WorkflowDefinition } from '@/types/orchestration';

// ─── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = 'user_test';

function makeWorkflow(definition: WorkflowDefinition) {
  return { id: 'wf_test', definition };
}

async function collect(
  engine: OrchestrationEngine,
  wf: ReturnType<typeof makeWorkflow>,
  opts: Parameters<OrchestrationEngine['execute']>[2] = { userId: USER_ID }
) {
  const events: ExecutionEvent[] = [];
  for await (const e of engine.execute(wf, {}, opts)) events.push(e);
  return events;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

describe('Per-step timeout and retriable errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRegistryForTests();
    vi.useFakeTimers();

    const mockCreate = prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>;
    mockCreate.mockResolvedValue({
      id: 'exec_test',
      status: 'running',
    });
    const mockUpdateMany = prisma.aiWorkflowExecution.updateMany as ReturnType<typeof vi.fn>;
    mockUpdateMany.mockResolvedValue({ count: 1 });
    const mockFindUnique = prisma.aiWorkflowExecution.findUnique as ReturnType<typeof vi.fn>;
    mockFindUnique.mockResolvedValue({ status: 'running' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails step with "step_timeout" when timeoutMs is exceeded', async () => {
    registerStepType('llm_call', async () => {
      // Simulate a slow executor.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return { output: 'done', tokensUsed: 0, costUsd: 0 };
    });

    const definition: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'Slow Step',
          type: 'llm_call',
          config: { prompt: 'test', timeoutMs: 100 },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    const engine = new OrchestrationEngine();
    const eventsPromise = collect(engine, makeWorkflow(definition));

    // Advance timers to trigger the timeout.
    await vi.advanceTimersByTimeAsync(150);

    const events = await eventsPromise;
    const failedEvent = events.find((e) => e.type === 'workflow_failed');
    expect(failedEvent).toBeDefined();
  });

  it('does not retry non-retriable errors even with retry strategy', async () => {
    let callCount = 0;
    registerStepType('llm_call', async (step) => {
      callCount++;
      throw new ExecutorError(step.id, 'http_error', 'HTTP 404: Not Found', undefined, false);
    });

    const definition: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'Non-retriable Step',
          type: 'llm_call',
          config: { prompt: 'test', errorStrategy: 'retry', retryCount: 3 },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    const engine = new OrchestrationEngine();
    const events = await collect(engine, makeWorkflow(definition));

    // Should NOT have retried — only called once.
    expect(callCount).toBe(1);

    const failedEvent = events.find((e) => e.type === 'workflow_failed');
    expect(failedEvent).toBeDefined();
  });

  it('retries retriable errors normally with retry strategy', async () => {
    let callCount = 0;
    registerStepType('llm_call', async (step) => {
      callCount++;
      if (callCount <= 2) {
        throw new ExecutorError(step.id, 'http_error_retriable', 'HTTP 503', undefined, true);
      }
      return { output: 'success', tokensUsed: 0, costUsd: 0 };
    });

    const definition: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'Retriable Step',
          type: 'llm_call',
          config: { prompt: 'test', errorStrategy: 'retry', retryCount: 3 },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    const engine = new OrchestrationEngine();

    // Engine uses setTimeout for backoff sleep — need to advance fake timers.
    const eventsPromise = collect(engine, makeWorkflow(definition));
    // Advance past both backoff delays (500ms + 1000ms).
    await vi.advanceTimersByTimeAsync(2000);

    const events = await eventsPromise;

    // Should have retried and eventually succeeded.
    expect(callCount).toBe(3);

    const completedEvent = events.find((e) => e.type === 'workflow_completed');
    expect(completedEvent).toBeDefined();
  });
});
