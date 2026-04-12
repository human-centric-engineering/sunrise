/**
 * Tests for `OrchestrationEngine.execute()` — event sequencing, error
 * strategies, budget enforcement, and human-approval pause semantics.
 *
 * Every executor is replaced with a simple stub via the registry. The
 * Prisma client is mocked so the DB checkpoints can be asserted
 * without touching a real database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before the engine import) ──────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  registerStepType,
} from '@/lib/orchestration/engine/executor-registry';
import { ExecutorError, PausedForApproval } from '@/lib/orchestration/engine/errors';
import { prisma } from '@/lib/db/client';
import type { ExecutionEvent, WorkflowDefinition } from '@/types/orchestration';

// ─── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = 'user_test';

function makeWorkflow(definition: WorkflowDefinition) {
  return { id: 'wf_test', definition };
}

function linearDefinition(): WorkflowDefinition {
  return {
    steps: [
      {
        id: 'a',
        name: 'Step A',
        type: 'llm_call',
        config: { prompt: 'A' },
        nextSteps: [{ targetStepId: 'b' }],
      },
      {
        id: 'b',
        name: 'Step B',
        type: 'llm_call',
        config: { prompt: 'B' },
        nextSteps: [],
      },
    ],
    entryStepId: 'a',
    errorStrategy: 'fail',
  };
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

describe('OrchestrationEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRegistryForTests();

    // Default prisma behaviour — row creation returns an id the engine
    // can use, updates succeed and echo the diff.
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'exec_test',
      workflowId: 'wf_test',
      userId: USER_ID,
      status: 'running',
      inputData: {},
      executionTrace: [],
      totalTokensUsed: 0,
      totalCostUsd: 0,
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
      const { where, data } = args as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      return { id: where.id, ...data };
    }) as never);
  });

  afterEach(() => {
    __resetRegistryForTests();
  });

  // Re-import the executors barrel to restore real executors for tests that
  // don't stub. Not strictly needed for these tests — all register their own.

  it('linear DAG yields workflow_started → step_* → workflow_completed', async () => {
    registerStepType('llm_call', async (step) => ({
      output: `out:${step.id}`,
      tokensUsed: 10,
      costUsd: 0.01,
    }));

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('workflow_started');
    expect(types.at(-1)).toBe('workflow_completed');
    expect(types.filter((t) => t === 'step_started')).toHaveLength(2);
    expect(types.filter((t) => t === 'step_completed')).toHaveLength(2);

    // Checkpoint after each completed step + a final finalize.
    expect(prisma.aiWorkflowExecution.update).toHaveBeenCalled();
  });

  it('accumulates tokens + cost on the terminal event', async () => {
    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 7, costUsd: 0.05 }));

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const terminal = events.at(-1) as Extract<ExecutionEvent, { type: 'workflow_completed' }>;
    expect(terminal.type).toBe('workflow_completed');
    expect(terminal.totalTokensUsed).toBe(14);
    expect(terminal.totalCostUsd).toBeCloseTo(0.1);
  });

  it('fail strategy emits workflow_failed and stops', async () => {
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError('a', 'bad', 'boom');
      return { output: 'unreached', tokensUsed: 0, costUsd: 0 };
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    expect(events.map((e) => e.type)).toContain('workflow_failed');
    expect(events.filter((e) => e.type === 'step_started')).toHaveLength(1);
  });

  it('skip strategy emits step_failed and continues with null output', async () => {
    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'skip' };
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError('a', 'bad', 'boom');
      return { output: 'b-output', tokensUsed: 1, costUsd: 0.001 };
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);
    expect(types).toContain('step_failed');
    expect(types).toContain('workflow_completed');
  });

  it('human_approval pauses execution with approval_required', async () => {
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A' },
          nextSteps: [{ targetStepId: 'gate' }],
        },
        {
          id: 'gate',
          name: 'Approval',
          type: 'human_approval',
          config: { prompt: 'ok?' },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };
    registerStepType('llm_call', async () => ({ output: 'pre', tokensUsed: 0, costUsd: 0 }));
    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, { prompt: 'ok?' });
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);
    expect(types).toContain('approval_required');
    // Paused — no workflow_completed, no workflow_failed.
    expect(types).not.toContain('workflow_completed');
    expect(types).not.toContain('workflow_failed');

    // Row should have been flipped to paused_for_approval.
    const pauseCall = vi
      .mocked(prisma.aiWorkflowExecution.update)
      .mock.calls.find(
        ([arg]) => (arg as { data: { status?: string } }).data.status === 'paused_for_approval'
      );
    expect(pauseCall).toBeDefined();
  });

  it('budget exceeded emits workflow_failed with "Budget exceeded"', async () => {
    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 1 }));

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()), {
      userId: USER_ID,
      budgetLimitUsd: 0.5,
    });
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed).toBeDefined();
    expect(failed.error).toBe('Budget exceeded');
  });

  it('budget warning fires at 80% of the limit', async () => {
    // Two steps × $0.42 = $0.84 which is > 80% of $1 on step 1, and exceeds budget on step 2.
    let call = 0;
    registerStepType('llm_call', async () => ({
      output: String(call++),
      tokensUsed: 0,
      costUsd: 0.42,
    }));
    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()), {
      userId: USER_ID,
      budgetLimitUsd: 0.5,
    });
    expect(events.map((e) => e.type)).toContain('budget_warning');
  });

  // ─── Retry strategy ────────────────────────────────────────────────

  it('retry strategy retries and succeeds on later attempt', async () => {
    let attempts = 0;
    registerStepType('llm_call', async (step) => {
      attempts++;
      if (step.id === 'a' && attempts <= 2) {
        throw new ExecutorError('a', 'transient', 'transient error');
      }
      return { output: `out:${step.id}`, tokensUsed: 1, costUsd: 0.001 };
    });

    const def = linearDefinition();
    // retryCount: 3 means up to 4 total attempts; we fail 2 so it succeeds on attempt 3.
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'retry', retryCount: 3 };

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    const retryEvents = events.filter(
      (e) => e.type === 'step_failed' && (e as { willRetry?: boolean }).willRetry === true
    );
    expect(retryEvents).toHaveLength(2);
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  }, 15_000);

  it('retry strategy exhausted emits workflow_failed', async () => {
    registerStepType('llm_call', async () => {
      throw new ExecutorError('a', 'always_fail', 'always fails');
    });

    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'retry', retryCount: 1 };

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    expect(events.map((e) => e.type)).toContain('workflow_failed');
  }, 15_000);

  // ─── Fallback strategy ─────────────────────────────────────────────

  it('fallback strategy invokes fallbackStepId', async () => {
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: {
            prompt: 'A',
            errorStrategy: 'fallback',
            fallbackStepId: 'fallback',
          },
          nextSteps: [{ targetStepId: 'b' }],
        },
        {
          id: 'fallback',
          name: 'Fallback',
          type: 'llm_call',
          config: { prompt: 'FB' },
          nextSteps: [],
        },
        {
          id: 'b',
          name: 'B',
          type: 'llm_call',
          config: { prompt: 'B' },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError('a', 'bad', 'boom');
      return { output: `out:${step.id}`, tokensUsed: 0, costUsd: 0 };
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);
    expect(types).toContain('step_failed');
    expect(types).toContain('workflow_completed');
    // The fallback step should have been executed
    const completed = events.filter((e) => e.type === 'step_completed');
    const completedIds = completed.map((e) => {
      if (e.type === 'step_completed') return e.stepId;
      return '';
    });
    expect(completedIds).toContain('fallback');
  });

  it('fallback without fallbackStepId behaves as skip', async () => {
    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'fallback' };
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError('a', 'bad', 'boom');
      return { output: 'ok', tokensUsed: 0, costUsd: 0 };
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);
    expect(types).toContain('step_failed');
    expect(types).toContain('workflow_completed');
  });

  // ─── Resume from paused_for_approval ───────────────────────────────

  it('resumes from paused_for_approval execution', async () => {
    registerStepType('llm_call', async (step) => ({
      output: `out:${step.id}`,
      tokensUsed: 5,
      costUsd: 0.01,
    }));

    // Simulate a previously paused execution — findUnique returns a row
    // with a trace and currentStep.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_resume',
      workflowId: 'wf_test',
      userId: USER_ID,
      status: 'paused_for_approval',
      inputData: {},
      executionTrace: [
        {
          stepId: 'a',
          stepType: 'llm_call',
          label: 'A',
          status: 'completed',
          output: 'out:a',
          tokensUsed: 5,
          costUsd: 0.01,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 10,
        },
      ],
      totalTokensUsed: 5,
      totalCostUsd: 0.01,
      budgetLimitUsd: null,
      currentStep: 'a',
      startedAt: new Date(),
      completedAt: null,
      outputData: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const events: ExecutionEvent[] = [];
    const engine = new OrchestrationEngine();
    for await (const e of engine.execute(
      makeWorkflow(linearDefinition()),
      {},
      {
        userId: USER_ID,
        resumeFromExecutionId: 'exec_resume',
      }
    )) {
      events.push(e);
    }

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('workflow_started');
    expect(types).toContain('workflow_completed');
    // Only step b should have been executed (a was already done)
    const started = events.filter((e) => e.type === 'step_started');
    expect(started).toHaveLength(1);
    const firstStarted = started[0];
    expect(firstStarted.type === 'step_started' && firstStarted.stepId).toBe('b');

    // Row should have been flipped to RUNNING during resume
    expect(prisma.aiWorkflowExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'running' }) })
    );
  });

  // ─── AbortSignal ───────────────────────────────────────────────────

  it('aborts execution when signal is already aborted', async () => {
    registerStepType('llm_call', async () => ({
      output: 'x',
      tokensUsed: 0,
      costUsd: 0,
    }));

    const controller = new AbortController();
    controller.abort();

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()), {
      userId: USER_ID,
      signal: controller.signal,
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_failed');
    expect(types).not.toContain('step_started');
  });

  // ─── Unknown step ID ──────────────────────────────────────────────

  it('unknown step ID in DAG emits workflow_failed', async () => {
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A' },
          nextSteps: [{ targetStepId: 'ghost' }],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    registerStepType('llm_call', async () => ({
      output: 'x',
      tokensUsed: 0,
      costUsd: 0,
    }));

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed).toBeDefined();
    expect(failed.error).toContain('ghost');
  });

  // ─── Non-ExecutorError wrapping ────────────────────────────────────

  it('wraps non-ExecutorError from executor into ExecutorError', async () => {
    registerStepType('llm_call', async () => {
      throw new Error('raw error');
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed).toBeDefined();
    expect(failed.error).toBe('raw error');
  });

  // ─── Terminal step ─────────────────────────────────────────────────

  it('terminal result stops DAG walk early', async () => {
    registerStepType('llm_call', async (step) => ({
      output: `out:${step.id}`,
      tokensUsed: 0,
      costUsd: 0,
      terminal: step.id === 'a',
    }));

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_completed');
    // Only step a should have been executed
    expect(events.filter((e) => e.type === 'step_completed')).toHaveLength(1);
  });

  // ─── PausedForApproval during retry ────────────────────────────────

  it('PausedForApproval during retry is re-thrown, not retried', async () => {
    let attempt = 0;
    registerStepType('llm_call', async (step) => {
      attempt++;
      if (step.id === 'a') {
        if (attempt === 1) throw new ExecutorError('a', 'transient', 'fail first');
        throw new PausedForApproval('a', { prompt: 'approve?' });
      }
      return { output: 'x', tokensUsed: 0, costUsd: 0 };
    });

    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'retry', retryCount: 3 };

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    const types = events.map((e) => e.type);
    expect(types).toContain('approval_required');
    expect(types).not.toContain('workflow_completed');
    expect(types).not.toContain('workflow_failed');
  }, 15_000);

  // ─── Checkpoint DB failure ─────────────────────────────────────────

  it('checkpoint DB failure is logged but does not crash the generator', async () => {
    registerStepType('llm_call', async () => ({
      output: 'x',
      tokensUsed: 0,
      costUsd: 0,
    }));

    // Make checkpoint (update) fail on all but the first call (create needs to work)
    let updateCalls = 0;
    vi.mocked(prisma.aiWorkflowExecution.update).mockImplementation((async () => {
      updateCalls++;
      if (updateCalls <= 2) throw new Error('DB down');
      return {};
    }) as never);

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const types = events.map((e) => e.type);
    // Engine should still complete despite checkpoint failures
    expect(types).toContain('workflow_completed');
  });
});
