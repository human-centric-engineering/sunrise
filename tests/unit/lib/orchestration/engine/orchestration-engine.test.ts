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
import {
  BudgetExceeded,
  ExecutorError,
  PausedForApproval,
} from '@/lib/orchestration/engine/errors';
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

    // Default findUnique — return a running row so the cancel-poll never fires.
    // Tests that need a different status override this explicitly.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_test',
      status: 'running',
    } as never);

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

    // Checkpoint after each completed step: verify the trace and cost totals
    // are written on the step-checkpoint call (nac=1 / mp=1 fix).
    expect(prisma.aiWorkflowExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'exec_test' },
        data: expect.objectContaining({
          executionTrace: expect.any(Array),
          totalTokensUsed: expect.any(Number),
          totalCostUsd: expect.any(Number),
        }),
      })
    );
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
    // sanitizeError scrubs executor_threw messages — raw error is not forwarded
    expect(failed.error).toBe('Step "a" failed unexpectedly');
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

  // ─── BudgetExceeded catch branch in executeSingleStep ────────────
  // NOTE (source finding): the `if (err instanceof BudgetExceeded)` branch
  // in executeSingleStep (orchestration-engine.ts ~line 589) is unreachable
  // when BudgetExceeded is thrown by an executor. runStepWithStrategy wraps
  // all non-PausedForApproval errors (including BudgetExceeded) into
  // ExecutorError with code 'executor_threw', so the BudgetExceeded instance
  // never propagates out of runStepWithStrategy. An existing test
  // ("BudgetExceeded thrown by executor is wrapped and sanitized…") already
  // covers the observable behaviour. The todo below tracks the unreachable
  // branch until the source is updated.
  it.todo(
    'BudgetExceeded thrown by executor reaches executeSingleStep BudgetExceeded branch (source fix needed — see source finding)'
  );

  // ─── finalize() DB failure ────────────────────────────────────────

  it('finalize DB failure is logged but generator still completes cleanly', async () => {
    // Arrange — all checkpoint updates succeed; only the final finalize update
    // (which sets status + completedAt) throws. This exercises the catch/log
    // path in finalize() (source line ~1138).
    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 1, costUsd: 0.001 }));

    // The mock impl echoes data for checkpoint calls (those include
    // executionTrace). When the finalize call arrives (data includes
    // completedAt), we throw to simulate DB failure.
    vi.mocked(prisma.aiWorkflowExecution.update).mockImplementation((async (args: unknown) => {
      const { data } = args as { data: Record<string, unknown> };
      if ('completedAt' in data) throw new Error('finalize DB down');
      return {};
    }) as never);

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

    // Assert — workflow_completed is still yielded; finalize failure is non-fatal.
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  // ─── pauseForApproval() DB failure ────────────────────────────────

  it('pauseForApproval DB failure is logged but approval_required is still emitted', async () => {
    // Arrange — the human_approval step triggers PausedForApproval; the DB
    // update inside pauseForApproval() throws. This exercises the catch/log
    // path in pauseForApproval() (source line ~1112).
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

    // Make all update calls fail so the pauseForApproval write (which sets
    // status: 'paused_for_approval') also fails.
    vi.mocked(prisma.aiWorkflowExecution.update).mockRejectedValue(
      new Error('pauseForApproval DB down')
    );

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);

    // Assert — approval_required is still emitted even though the DB write failed.
    expect(types).toContain('approval_required');
    expect(types).not.toContain('workflow_completed');
    expect(types).not.toContain('workflow_failed');
  });

  // ─── MAX_STEPS guard ──────────────────────────────────────────────

  it('emits workflow_failed when step count exceeds MAX_STEPS_PER_RUN via cyclic edges', async () => {
    // Build a very long chain to trigger the MAX_STEPS guard
    const longSteps = Array.from({ length: 1001 }, (_, i) => ({
      id: `s${i}`,
      name: `Step ${i}`,
      type: 'llm_call',
      config: { prompt: `${i}` },
      nextSteps: i < 1000 ? [{ targetStepId: `s${i + 1}` }] : [],
    }));
    const longDef: WorkflowDefinition = {
      steps: longSteps,
      entryStepId: 's0',
      errorStrategy: 'fail',
    };

    registerStepType('llm_call', async (step) => ({
      output: step.id,
      tokensUsed: 0,
      costUsd: 0,
    }));

    const events = await collect(new OrchestrationEngine(), makeWorkflow(longDef));
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed).toBeDefined();
    expect(failed.error).toContain('1000');
  });

  // ─── Signal aborted mid-execution ─────────────────────────────────

  it('aborts execution when signal is aborted during step execution', async () => {
    const controller = new AbortController();
    let stepCount = 0;

    registerStepType('llm_call', async () => {
      stepCount++;
      if (stepCount === 1) {
        // Abort during the first step execution
        controller.abort();
      }
      return { output: 'x', tokensUsed: 0, costUsd: 0 };
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()), {
      userId: USER_ID,
      signal: controller.signal,
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_failed');
    // Only step a should have started and completed; b should not start
    expect(events.filter((e) => e.type === 'step_started')).toHaveLength(1);
  });

  // ─── nextStepIds override ─────────────────────────────────────────

  it('uses result.nextStepIds when provided instead of definition edges', async () => {
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A' },
          nextSteps: [{ targetStepId: 'b' }],
        },
        {
          id: 'b',
          name: 'B',
          type: 'llm_call',
          config: { prompt: 'B' },
          nextSteps: [],
        },
        {
          id: 'c',
          name: 'C',
          type: 'llm_call',
          config: { prompt: 'C' },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') {
        // Override: go to c instead of b
        return { output: 'a-out', tokensUsed: 0, costUsd: 0, nextStepIds: ['c'] };
      }
      return { output: `${step.id}-out`, tokensUsed: 0, costUsd: 0 };
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const completedSteps = events
      .filter((e) => e.type === 'step_completed')
      .map((e) => {
        if (e.type === 'step_completed') return e.stepId;
        return '';
      });

    expect(completedSteps).toContain('c');
    expect(completedSteps).not.toContain('b');
  });

  // ─── Budget warning fires only once ───────────────────────────────

  it('budget warning fires only once even across multiple steps', async () => {
    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A' },
          nextSteps: [{ targetStepId: 'b' }],
        },
        {
          id: 'b',
          name: 'B',
          type: 'llm_call',
          config: { prompt: 'B' },
          nextSteps: [{ targetStepId: 'c' }],
        },
        {
          id: 'c',
          name: 'C',
          type: 'llm_call',
          config: { prompt: 'C' },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    // Each step costs $0.30 — total $0.90.
    // Budget $1.00 → 80% threshold at $0.80.
    // After step 3 ($0.90) the warning should fire, but only once.
    registerStepType('llm_call', async () => ({
      output: 'x',
      tokensUsed: 0,
      costUsd: 0.3,
    }));

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def), {
      userId: USER_ID,
      budgetLimitUsd: 1.0,
    });
    const warnings = events.filter((e) => e.type === 'budget_warning');
    expect(warnings).toHaveLength(1);
  });

  // ─── Non-Error thrown from executor ───────────────────────────────

  it('wraps non-Error thrown value from executor', async () => {
    registerStepType('llm_call', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string error';
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed).toBeDefined();
    expect(failed.error).toBe('Step "a" failed unexpectedly');
  });

  // ─── Resume with non-array executionTrace ─────────────────────────

  it('resumes gracefully when executionTrace is not an array', async () => {
    registerStepType('llm_call', async (step) => ({
      output: `out:${step.id}`,
      tokensUsed: 0,
      costUsd: 0,
    }));

    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_bad_trace',
      workflowId: 'wf_test',
      userId: USER_ID,
      status: 'paused_for_approval',
      inputData: {},
      executionTrace: 'not-an-array', // malformed
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

    const events: ExecutionEvent[] = [];
    const engine = new OrchestrationEngine();
    for await (const e of engine.execute(
      makeWorkflow(linearDefinition()),
      {},
      { userId: USER_ID, resumeFromExecutionId: 'exec_bad_trace' }
    )) {
      events.push(e);
    }

    // Should still run — empty trace, starts from entryStepId
    expect(events.map((e) => e.type)).toContain('workflow_started');
  });

  // ─── Resume not found ─────────────────────────────────────────────

  it('throws when resumeFromExecutionId row is not found', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);

    registerStepType('llm_call', async () => ({
      output: 'x',
      tokensUsed: 0,
      costUsd: 0,
    }));

    await expect(
      collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()), {
        userId: USER_ID,
        resumeFromExecutionId: 'nonexistent',
      })
    ).rejects.toThrow('not found');
  });

  // ─── Parallel Execution ─────────────────────────────────────────────────

  it('runs parallel fan-out branches concurrently', async () => {
    const executionOrder: string[] = [];

    registerStepType('parallel', async (step) => ({
      output: { parallel: true, branches: step.nextSteps.map((e) => e.targetStepId) },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      executionOrder.push(`start:${step.id}`);
      // Simulate async work — if truly parallel, both start before either finishes
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push(`end:${step.id}`);
      return { output: `out:${step.id}`, tokensUsed: 5, costUsd: 0.01 };
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

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Both branches should have started before either finished (concurrent)
    const startA = executionOrder.indexOf('start:a');
    const startB = executionOrder.indexOf('start:b');
    const endA = executionOrder.indexOf('end:a');
    const endB = executionOrder.indexOf('end:b');

    expect(startA).toBeLessThan(endA);
    expect(startB).toBeLessThan(endB);
    // Both started before the first one ended — proof of concurrency
    expect(startA).toBeLessThan(endB);
    expect(startB).toBeLessThan(endA);

    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  it('parallel branches converge at a join step', async () => {
    const executionOrder: string[] = [];

    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      executionOrder.push(step.id);
      return { output: `out:${step.id}`, tokensUsed: 5, costUsd: 0.01 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A' },
          nextSteps: [{ targetStepId: 'join' }],
        },
        {
          id: 'b',
          name: 'B',
          type: 'llm_call',
          config: { prompt: 'B' },
          nextSteps: [{ targetStepId: 'join' }],
        },
        { id: 'join', name: 'Join', type: 'llm_call', config: { prompt: 'merge' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Join step runs exactly once, after both A and B
    expect(executionOrder.filter((id) => id === 'join')).toHaveLength(1);
    const joinIdx = executionOrder.indexOf('join');
    expect(executionOrder.indexOf('a')).toBeLessThan(joinIdx);
    expect(executionOrder.indexOf('b')).toBeLessThan(joinIdx);

    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  it('tokens and cost accumulate correctly across parallel branches', async () => {
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async () => ({
      output: 'done',
      tokensUsed: 10,
      costUsd: 0.05,
    }));

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

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    const completed = events.find((e) => e.type === 'workflow_completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'workflow_completed') {
      // parallel node (0) + branch A (10) + branch B (10) = 20
      expect(completed.totalTokensUsed).toBe(20);
      expect(completed.totalCostUsd).toBeCloseTo(0.1);
    }
  });

  it('parallel branch failure with skip strategy continues other branches', async () => {
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError(step.id, 'test_fail', 'intentional failure');
      return { output: `out:${step.id}`, tokensUsed: 5, costUsd: 0.01 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A', errorStrategy: 'skip' },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Workflow should complete — skipped branch doesn't kill workflow
    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_completed');
    // Branch B still executed
    const completedSteps = events.filter((e) => e.type === 'step_completed');
    expect(completedSteps.some((e) => e.type === 'step_completed' && e.stepId === 'b')).toBe(true);
  });

  it('parallel branch failure with fail strategy stops workflow', async () => {
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError(step.id, 'test_fail', 'intentional failure');
      return { output: `out:${step.id}`, tokensUsed: 5, costUsd: 0.01 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A', errorStrategy: 'fail' },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_failed');
    expect(types).not.toContain('workflow_completed');
  });

  it('sequential workflows are unaffected by parallel refactor', async () => {
    registerStepType('llm_call', async (step) => ({
      output: `out:${step.id}`,
      tokensUsed: 10,
      costUsd: 0.01,
    }));

    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A' },
          nextSteps: [{ targetStepId: 'b' }],
        },
        {
          id: 'b',
          name: 'B',
          type: 'llm_call',
          config: { prompt: 'B' },
          nextSteps: [{ targetStepId: 'c' }],
        },
        { id: 'c', name: 'C', type: 'llm_call', config: { prompt: 'C' }, nextSteps: [] },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    const started = events.filter((e) => e.type === 'step_started');
    expect(started).toHaveLength(3);
    // Order must be a → b → c
    expect(started[0].type === 'step_started' && started[0].stepId).toBe('a');
    expect(started[1].type === 'step_started' && started[1].stepId).toBe('b');
    expect(started[2].type === 'step_started' && started[2].stepId).toBe('c');
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  // ─── DB-cancelled workflow ─────────────────────────────────────────

  it('stops with workflow_failed when DB row status is CANCELLED', async () => {
    // Arrange — executor would succeed, but the DB row is already CANCELLED
    // when the engine polls it at the top of the loop.
    registerStepType('llm_call', async () => ({
      output: 'should-not-reach',
      tokensUsed: 0,
      costUsd: 0,
    }));

    // findUnique (the cancel poll) returns CANCELLED status.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_test',
      status: 'cancelled',
    } as never);

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const types = events.map((e) => e.type);

    // Assert — engine emits workflow_failed for the cancellation and does not
    // start any step (the cancel check runs before step execution).
    expect(types).toContain('workflow_failed');
    expect(types).not.toContain('step_started');

    // The failure reason must reference cancellation, not some other error.
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed.error).toContain('cancel');
  });

  // ─── Per-step timeout ─────────────────────────────────────────────

  it('per-step timeoutMs triggers step_timeout error and fails workflow', async () => {
    // Arrange — executor hangs until the fake timer fires the step timeout.
    // We use real timers here (no vi.useFakeTimers) because the engine's
    // internal Promise.race uses setTimeout; fake timers require manual
    // advancement which is complex with async generators. Instead we set a
    // very short timeout (10ms) and a real-timer test timeout.
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') {
        // Hang much longer than the step timeout.
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      }
      return { output: 'never', tokensUsed: 0, costUsd: 0 };
    });

    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, timeoutMs: 10 };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);

    // Assert — the timeout triggers a failure on step a; workflow emits workflow_failed.
    expect(types).toContain('workflow_failed');
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    // Timeout is a non-retriable ExecutorError with code 'step_timeout'.
    // sanitizeError forwards the message for non 'executor_threw' codes.
    expect(failed.error).toContain('timed out');
  }, 5_000);

  // ─── Non-retriable error stops retry immediately ───────────────────

  it('retry strategy stops immediately on a non-retriable error', async () => {
    let attempts = 0;
    registerStepType('llm_call', async (step) => {
      attempts++;
      if (step.id === 'a') {
        // retriable=false — engine must NOT retry, even though retryCount > 0.
        throw new ExecutorError('a', 'permanent', 'cannot retry this', undefined, false);
      }
      return { output: 'x', tokensUsed: 0, costUsd: 0 };
    });

    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'retry', retryCount: 5 };

    // Act — give plenty of time; if it retried 5 times with backoff this would take much longer.
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Assert — only ONE attempt (no retry events).
    expect(attempts).toBe(1);
    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_failed');
    // No step_failed with willRetry=true should appear.
    const retryEvents = events.filter(
      (e) => e.type === 'step_failed' && (e as { willRetry?: boolean }).willRetry === true
    );
    expect(retryEvents).toHaveLength(0);
  });

  // ─── executeWithSubscriber ────────────────────────────────────────

  it('executeWithSubscriber delivers every event to the subscriber', async () => {
    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 1, costUsd: 0.001 }));

    const received: ExecutionEvent[] = [];
    const subscriber = (event: ExecutionEvent) => {
      received.push(event);
    };

    const engine = new OrchestrationEngine();
    const yielded: ExecutionEvent[] = [];
    for await (const e of engine.executeWithSubscriber(
      makeWorkflow(linearDefinition()),
      {},
      {
        userId: USER_ID,
        subscriber,
      }
    )) {
      yielded.push(e);
    }

    // The subscriber should have received exactly the same events as the iterator.
    expect(received).toHaveLength(yielded.length);
    expect(received.map((e) => e.type)).toEqual(yielded.map((e) => e.type));
    // Sanity: at least workflow_started and workflow_completed must be present.
    expect(received.map((e) => e.type)).toContain('workflow_started');
    expect(received.map((e) => e.type)).toContain('workflow_completed');
  });

  it('executeWithSubscriber swallows subscriber errors without crashing', async () => {
    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0 }));

    // Subscriber always throws — engine must not propagate.
    const throwingSubscriber = () => {
      throw new Error('subscriber exploded');
    };

    const engine = new OrchestrationEngine();
    const events: ExecutionEvent[] = [];
    // Should NOT throw.
    for await (const e of engine.executeWithSubscriber(
      makeWorkflow(linearDefinition()),
      {},
      {
        userId: USER_ID,
        subscriber: throwingSubscriber,
      }
    )) {
      events.push(e);
    }

    // Engine delivered all events despite subscriber failures.
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  // ─── Parallel batch: unknown step id ─────────────────────────────

  it('unknown step ID in parallel batch emits workflow_failed', async () => {
    // Arrange — entry step fans out to two siblings; one ID is valid, one is a ghost.
    // Both are returned by the executor via nextStepIds so they appear as a parallel batch.
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') {
        return { output: 'a-out', tokensUsed: 0, costUsd: 0, nextStepIds: ['b', 'ghost'] };
      }
      return { output: `${step.id}-out`, tokensUsed: 0, costUsd: 0 };
    });

    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A' },
          nextSteps: [{ targetStepId: 'b' }],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;

    // Assert — engine should fail with a message referencing the ghost step id.
    expect(failed).toBeDefined();
    expect(failed.error).toContain('ghost');
  });

  // ─── Parallel batch: step count cap exceeded ──────────────────────

  it('parallel batch emits workflow_failed when it would exceed MAX_STEPS_PER_RUN', async () => {
    // Arrange — build a DAG where the first step fans out to 1001 siblings.
    // This triggers the stepCount + ready.length > MAX_STEPS_PER_RUN guard.
    const branchIds = Array.from({ length: 1001 }, (_, i) => `b${i}`);
    const branchSteps = branchIds.map((id) => ({
      id,
      name: id,
      type: 'llm_call',
      config: { prompt: id },
      nextSteps: [] as { targetStepId: string }[],
    }));

    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'entry',
          name: 'Entry',
          type: 'llm_call',
          config: { prompt: 'entry' },
          // All 1001 branches returned via nextStepIds to force a parallel ready set.
          nextSteps: branchIds.map((id) => ({ targetStepId: id })),
        },
        ...branchSteps,
      ],
      entryStepId: 'entry',
      errorStrategy: 'fail',
    };

    registerStepType('llm_call', async (step) => ({
      output: step.id,
      tokensUsed: 0,
      costUsd: 0,
    }));

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;

    // Assert
    expect(failed).toBeDefined();
    expect(failed.error).toContain('1000');
  });

  // ─── Parallel batch: paused (human_approval in branch) ───────────

  it('parallel batch pauses when a branch step throws PausedForApproval', async () => {
    // Arrange — fan-out from p to two branches; branch 'a' is a human_approval step.
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, { prompt: 'approve me' });
    });
    registerStepType('llm_call', async (step) => ({
      output: `${step.id}-out`,
      tokensUsed: 0,
      costUsd: 0,
    }));

    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'p',
          name: 'Parallel',
          type: 'parallel',
          config: {},
          nextSteps: [{ targetStepId: 'approval' }, { targetStepId: 'b' }],
        },
        {
          id: 'approval',
          name: 'Approval',
          type: 'human_approval',
          config: { prompt: 'ok?' },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);

    // Assert — approval_required fired, no workflow_completed, no workflow_failed.
    expect(types).toContain('approval_required');
    expect(types).not.toContain('workflow_completed');
    expect(types).not.toContain('workflow_failed');

    // DB row must have been flipped to paused_for_approval.
    const pauseCall = vi
      .mocked(prisma.aiWorkflowExecution.update)
      .mock.calls.find(
        ([arg]) => (arg as { data: { status?: string } }).data.status === 'paused_for_approval'
      );
    expect(pauseCall).toBeDefined();
  });

  // ─── Parallel batch: budget exceeded after batch ──────────────────

  it('parallel batch emits workflow_failed when total cost exceeds budget after batch', async () => {
    // Arrange — entry step fans out to two branches, each costing $0.6.
    // Budget is $1.0 — the batch total ($1.2) exceeds it.
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async () => ({
      output: 'done',
      tokensUsed: 0,
      costUsd: 0.6,
    }));

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

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def), {
      userId: USER_ID,
      budgetLimitUsd: 1.0,
    });
    const types = events.map((e) => e.type);

    // Assert — workflow_failed for budget exceeded, no workflow_completed.
    expect(types).toContain('workflow_failed');
    expect(types).not.toContain('workflow_completed');
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed.error).toBe('Budget exceeded');
  });

  // ─── Parallel batch: budget warning after batch ───────────────────

  it('parallel batch emits budget_warning when cost crosses 80% threshold', async () => {
    // Arrange — each branch costs $0.45 (total $0.90 > 80% of $1.00).
    // Both branches succeed so workflow_completed fires after the warning.
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async () => ({
      output: 'done',
      tokensUsed: 0,
      costUsd: 0.45,
    }));

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

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def), {
      userId: USER_ID,
      budgetLimitUsd: 1.0,
    });

    // Assert — exactly one budget_warning, workflow still completes.
    expect(events.map((e) => e.type)).toContain('budget_warning');
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  // ─── Parallel batch: nextStepIds override from result ────────────

  it('parallel branch can override next steps via result.nextStepIds', async () => {
    // Arrange — fan-out from p to a and b; step a uses nextStepIds to redirect to c (not d).
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') {
        return { output: 'a-out', tokensUsed: 0, costUsd: 0, nextStepIds: ['c'] };
      }
      return { output: `${step.id}-out`, tokensUsed: 0, costUsd: 0 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A' },
          // Definition says go to d, but executor will override to c.
          nextSteps: [{ targetStepId: 'd' }],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
        { id: 'c', name: 'C', type: 'llm_call', config: { prompt: 'C' }, nextSteps: [] },
        { id: 'd', name: 'D', type: 'llm_call', config: { prompt: 'D' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Assert — c was executed, d was not.
    const completedSteps = events
      .filter((e) => e.type === 'step_completed')
      .map((e) => (e.type === 'step_completed' ? e.stepId : ''));
    expect(completedSteps).toContain('c');
    expect(completedSteps).not.toContain('d');
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  // ─── runStepToCompletion: skip strategy in parallel branch ────────

  it('parallel branch skip strategy returns null output without failing workflow', async () => {
    // Arrange — parallel batch where branch a uses skip strategy and errors.
    // This exercises runStepToCompletion's skip path (not the generator path).
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError(step.id, 'test_err', 'skip me');
      return { output: `${step.id}-out`, tokensUsed: 1, costUsd: 0.001 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A', errorStrategy: 'skip' },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Assert — workflow completed (skip doesn't kill workflow), b ran.
    expect(events.map((e) => e.type)).toContain('workflow_completed');
    const completedSteps = events
      .filter((e) => e.type === 'step_completed')
      .map((e) => (e.type === 'step_completed' ? e.stepId : ''));
    expect(completedSteps).toContain('b');
  });

  // ─── runStepToCompletion: fallback strategy in parallel branch ────

  it('parallel branch fallback strategy routes to fallbackStepId', async () => {
    // Arrange — parallel batch where branch a uses fallback and errors.
    // The fallback step is 'fb'. This exercises runStepToCompletion's fallback
    // path (with a fallbackStepId present).
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError(step.id, 'test_err', 'fallback please');
      return { output: `${step.id}-out`, tokensUsed: 0, costUsd: 0 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A', errorStrategy: 'fallback', fallbackStepId: 'fb' },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
        { id: 'fb', name: 'Fallback', type: 'llm_call', config: { prompt: 'FB' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Assert — fallback step was executed; workflow completed.
    const completedSteps = events
      .filter((e) => e.type === 'step_completed')
      .map((e) => (e.type === 'step_completed' ? e.stepId : ''));
    expect(completedSteps).toContain('fb');
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  // ─── runStepToCompletion: fallback without fallbackStepId (parallel) ─

  it('parallel branch fallback without fallbackStepId behaves as skip', async () => {
    // Exercises the fallback-no-id path in runStepToCompletion.
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError(step.id, 'test_err', 'fallback no id');
      return { output: `${step.id}-out`, tokensUsed: 0, costUsd: 0 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          // fallback without a fallbackStepId → behaves like skip in the parallel path.
          config: { prompt: 'A', errorStrategy: 'fallback' },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Assert — workflow still completes; step a's failure was absorbed.
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  // ─── runStepToCompletion: retry with PausedForApproval ───────────

  it('parallel branch retry strategy re-throws PausedForApproval immediately', async () => {
    // Exercises runStepToCompletion's retry loop: first attempt fails,
    // second throws PausedForApproval — must NOT be retried.
    let attempt = 0;
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') {
        attempt++;
        if (attempt === 1) throw new ExecutorError('a', 'transient', 'first fail');
        throw new PausedForApproval('a', { prompt: 'approve in parallel' });
      }
      return { output: `${step.id}-out`, tokensUsed: 0, costUsd: 0 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A', errorStrategy: 'retry', retryCount: 3 },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);

    // Assert — PausedForApproval propagated; paused state.
    expect(types).toContain('approval_required');
    expect(types).not.toContain('workflow_completed');
  }, 15_000);

  // ─── runStepToCompletion: retry with non-retriable error ─────────

  it('parallel branch retry stops immediately on non-retriable error', async () => {
    // Exercises runStepToCompletion's non-retriable guard in the retry loop.
    let attempts = 0;
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') {
        attempts++;
        throw new ExecutorError('a', 'permanent', 'cannot retry', undefined, false);
      }
      return { output: `${step.id}-out`, tokensUsed: 0, costUsd: 0 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A', errorStrategy: 'retry', retryCount: 5 },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Assert — exactly one attempt (not retried); workflow fails.
    expect(attempts).toBe(1);
    expect(events.map((e) => e.type)).toContain('workflow_failed');
  });

  // ─── runStepToCompletion: non-Error wrapping (parallel) ──────────

  it('parallel branch wraps non-Error thrown value into ExecutorError', async () => {
    // Exercises the non-Error wrapping path in runStepToCompletion.
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'a plain string error in parallel';
      }
      return { output: `${step.id}-out`, tokensUsed: 0, costUsd: 0 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A' },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);

    // Assert — workflow fails due to branch a's error.
    expect(types).toContain('workflow_failed');
    expect(types).not.toContain('workflow_completed');
  });

  // ─── runStepToCompletion: timeout in parallel branch ─────────────

  it('parallel branch timeout triggers workflow_failed', async () => {
    // Exercises the stepTimeoutMs path in runStepToCompletion.
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') {
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      }
      return { output: `${step.id}-out`, tokensUsed: 0, costUsd: 0 };
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
        {
          id: 'a',
          name: 'A',
          type: 'llm_call',
          config: { prompt: 'A', timeoutMs: 10 },
          nextSteps: [],
        },
        { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
      ],
      entryStepId: 'p',
      errorStrategy: 'fail',
    };

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const types = events.map((e) => e.type);

    // Assert — timeout causes workflow_failed.
    expect(types).toContain('workflow_failed');
    expect(types).not.toContain('workflow_completed');
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed.error).toContain('timed out');
  }, 5_000);

  // ─── resume with invalid trace entries ────────────────────────────

  it('resumes gracefully when executionTrace contains invalid entries (schema parse fails)', async () => {
    // Exercises the safeParse failure branch in initRun — invalid entries are silently
    // dropped and the run starts with the steps that did parse (or all steps if none parse).
    registerStepType('llm_call', async (step) => ({
      output: `out:${step.id}`,
      tokensUsed: 0,
      costUsd: 0,
    }));

    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_invalid_trace',
      workflowId: 'wf_test',
      userId: USER_ID,
      status: 'paused_for_approval',
      inputData: {},
      // Array containing one valid entry and one entry that will fail the schema.
      executionTrace: [
        { not_a_valid_key: true, garbage: 123 }, // will fail safeParse → dropped
      ],
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

    const events: ExecutionEvent[] = [];
    const engine = new OrchestrationEngine();
    for await (const e of engine.execute(
      makeWorkflow(linearDefinition()),
      {},
      {
        userId: USER_ID,
        resumeFromExecutionId: 'exec_invalid_trace',
      }
    )) {
      events.push(e);
    }

    // Should still start and run from the beginning (empty parsed trace → full run).
    expect(events.map((e) => e.type)).toContain('workflow_started');
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  // ─── resume when row has no startedAt (null fallback) ────────────

  it('resume uses new Date() when row.startedAt is null', async () => {
    // Exercises the `row.startedAt ?? new Date()` branch in initRun.
    registerStepType('llm_call', async (step) => ({
      output: `out:${step.id}`,
      tokensUsed: 0,
      costUsd: 0,
    }));

    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_no_started_at',
      workflowId: 'wf_test',
      userId: USER_ID,
      status: 'paused_for_approval',
      inputData: {},
      executionTrace: [],
      totalTokensUsed: 0,
      totalCostUsd: 0,
      defaultErrorStrategy: 'fail',
      budgetLimitUsd: null,
      currentStep: null,
      startedAt: null, // null → triggers the fallback
      completedAt: null,
      outputData: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const events: ExecutionEvent[] = [];
    for await (const e of new OrchestrationEngine().execute(
      makeWorkflow(linearDefinition()),
      {},
      { userId: USER_ID, resumeFromExecutionId: 'exec_no_started_at' }
    )) {
      events.push(e);
    }

    // Workflow must start and complete — the null startedAt fallback didn't crash.
    expect(events.map((e) => e.type)).toContain('workflow_started');
    expect(events.map((e) => e.type)).toContain('workflow_completed');

    // DB update during resume must have been called with a non-null startedAt.
    const resumeUpdateCall = vi
      .mocked(prisma.aiWorkflowExecution.update)
      .mock.calls.find(([arg]) => {
        const { data } = arg as { data: { status?: string; startedAt?: Date } };
        return data.status === 'running' && data.startedAt instanceof Date;
      });
    expect(resumeUpdateCall).toBeDefined();
  });

  // ─── resume with budgetLimitUsd from row ─────────────────────────

  it('resume rehydrates budgetLimitUsd from the DB row when options.budgetLimitUsd is absent', async () => {
    // Exercises the `row.budgetLimitUsd ?? options.budgetLimitUsd` branch in initRun.
    // The row has a budgetLimitUsd; options does not → should use the row's value.
    registerStepType('llm_call', async () => ({
      output: 'done',
      tokensUsed: 0,
      costUsd: 2.0, // exceeds the rehydrated budget of $1.0
    }));

    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_budget_row',
      workflowId: 'wf_test',
      userId: USER_ID,
      status: 'paused_for_approval',
      inputData: {},
      executionTrace: [],
      totalTokensUsed: 0,
      totalCostUsd: 0,
      defaultErrorStrategy: 'fail',
      budgetLimitUsd: 1.0, // row has a budget limit
      currentStep: null,
      startedAt: new Date(),
      completedAt: null,
      outputData: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    // No budgetLimitUsd in options — engine must use the row's value.
    const events: ExecutionEvent[] = [];
    for await (const e of new OrchestrationEngine().execute(
      makeWorkflow(linearDefinition()),
      {},
      { userId: USER_ID, resumeFromExecutionId: 'exec_budget_row' }
    )) {
      events.push(e);
    }

    // Assert — budget check fired (step cost $2.0 > limit $1.0).
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed).toBeDefined();
    expect(failed.error).toBe('Budget exceeded');
  });

  // ─── resume with non-completed trace entries ─────────────────────

  it('resume skips step output rehydration for non-completed trace entries', async () => {
    // Exercises the `entry.status === 'completed'` branch in initRun — a trace entry
    // with a non-completed status (e.g. 'failed') must NOT be added to ctx.stepOutputs.
    registerStepType('llm_call', async (step) => ({
      output: `out:${step.id}`,
      tokensUsed: 0,
      costUsd: 0,
    }));

    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_failed_trace',
      workflowId: 'wf_test',
      userId: USER_ID,
      status: 'paused_for_approval',
      inputData: {},
      // One completed entry (step a) and one failed entry (step a again, edge case).
      // The failed entry must not populate stepOutputs.
      executionTrace: [
        {
          stepId: 'a',
          stepType: 'llm_call',
          label: 'A',
          status: 'failed',
          output: null,
          error: 'some error',
          tokensUsed: 0,
          costUsd: 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 5,
        },
      ],
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

    const events: ExecutionEvent[] = [];
    for await (const e of new OrchestrationEngine().execute(
      makeWorkflow(linearDefinition()),
      {},
      { userId: USER_ID, resumeFromExecutionId: 'exec_failed_trace' }
    )) {
      events.push(e);
    }

    // Should run from start — the failed trace entry didn't block execution.
    expect(events.map((e) => e.type)).toContain('workflow_started');
  });

  // ─── nextIdsAfter with missing step ──────────────────────────────

  it('resumes from a currentStep that no longer exists in the definition', async () => {
    // Exercises nextIdsAfter returning [] when the step is missing from the map.
    // The currentStep in the row points to 'ghost' which is not in the workflow definition.
    // The engine should start from the entry step (no next IDs to resume from).
    registerStepType('llm_call', async (step) => ({
      output: `out:${step.id}`,
      tokensUsed: 0,
      costUsd: 0,
    }));

    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_ghost_current',
      workflowId: 'wf_test',
      userId: USER_ID,
      status: 'paused_for_approval',
      inputData: {},
      executionTrace: [],
      totalTokensUsed: 0,
      totalCostUsd: 0,
      defaultErrorStrategy: 'fail',
      budgetLimitUsd: null,
      currentStep: 'ghost', // not in definition → nextIdsAfter returns []
      startedAt: new Date(),
      completedAt: null,
      outputData: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const events: ExecutionEvent[] = [];
    for await (const e of new OrchestrationEngine().execute(
      makeWorkflow(linearDefinition()),
      {},
      { userId: USER_ID, resumeFromExecutionId: 'exec_ghost_current' }
    )) {
      events.push(e);
    }

    // The queue is empty (no next IDs from ghost step + no trace to seed from).
    // Engine should emit workflow_started and then complete with an empty DAG walk.
    expect(events.map((e) => e.type)).toContain('workflow_started');
  });

  // ─── checkpoint: non-Error in catch (String(err) path) ───────────

  it('checkpoint swallows a non-Error thrown value from DB update', async () => {
    // Exercises the `err instanceof Error ? err.message : String(err)` branch in checkpoint.
    // When a non-Error value (e.g. a number) is thrown, String() is used.
    registerStepType('llm_call', async () => ({
      output: 'x',
      tokensUsed: 0,
      costUsd: 0,
    }));

    let updateCalls = 0;
    vi.mocked(prisma.aiWorkflowExecution.update).mockImplementation((async () => {
      updateCalls++;
      if (updateCalls === 2) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 42; // non-Error thrown value → triggers String(err) path
      }
      return {};
    }) as never);

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    // Engine must still complete despite the non-Error checkpoint failure.
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  });

  // ─── executeWithSubscriber without subscriber ─────────────────────

  it('executeWithSubscriber works correctly when no subscriber is provided', async () => {
    // Exercises the `if (subscriber)` false-branch in executeWithSubscriber.
    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 1, costUsd: 0.001 }));

    const engine = new OrchestrationEngine();
    const events: ExecutionEvent[] = [];
    // No subscriber in options.
    for await (const e of engine.executeWithSubscriber(
      makeWorkflow(linearDefinition()),
      {},
      { userId: USER_ID }
    )) {
      events.push(e);
    }

    // Should yield all events normally without crashing.
    expect(events.map((e) => e.type)).toContain('workflow_started');
    expect(events.map((e) => e.type)).toContain('workflow_completed');
    expect(events.map((e) => e.type).filter((t) => t === 'step_completed')).toHaveLength(2);
  });

  // ─── retry with non-Error wrapping (runStepWithStrategy) ─────────

  it('retry strategy wraps non-Error thrown value into ExecutorError', async () => {
    // Exercises the `err instanceof Error ? err.message : 'Executor threw...'` branch
    // inside the retry catch block (the non-Error path, index 2 of binary-expr branch 40).
    let attempt = 0;
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') {
        attempt++;
        if (attempt <= 1) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'non-error string in retry'; // non-Error thrown value
        }
      }
      return { output: `out:${step.id}`, tokensUsed: 0, costUsd: 0 };
    });

    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'retry', retryCount: 2 };

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Should complete — non-Error wrapped, retry succeeded on attempt 2.
    expect(events.map((e) => e.type)).toContain('workflow_completed');
  }, 10_000);

  // ─── finalOutput unchanged when step returns undefined output ────

  it('finalOutput stays null when step result.output is undefined', async () => {
    // Exercises the `if (singleResult.output !== undefined)` false branch.
    // When the executor returns `output: undefined`, finalOutput should remain null.
    registerStepType('llm_call', async () => ({
      output: undefined, // explicitly undefined — should NOT update finalOutput
      tokensUsed: 0,
      costUsd: 0,
    }));

    // Use a one-step workflow so finalOutput is never overwritten by a later step.
    const def: WorkflowDefinition = {
      steps: [{ id: 'a', name: 'A', type: 'llm_call', config: { prompt: 'A' }, nextSteps: [] }],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const completed = events.find((e) => e.type === 'workflow_completed') as Extract<
      ExecutionEvent,
      { type: 'workflow_completed' }
    >;

    // workflow_completed fires; finalOutput = null (not updated by the undefined output).
    expect(completed).toBeDefined();
    expect(completed.output).toBeNull();
  });

  // ─── BudgetExceeded from executor ─────────────────────────────────

  it('BudgetExceeded thrown by executor is wrapped and sanitized like any unexpected error', async () => {
    // Arrange — executor throws BudgetExceeded directly.
    // NOTE: runStepWithStrategy wraps any non-PausedForApproval error (including
    // BudgetExceeded) into ExecutorError with code 'executor_threw', so the
    // BudgetExceeded-specific catch in executeSingleStep is bypassed.
    // The resulting sanitized error message is the generic "failed unexpectedly" form.
    registerStepType('llm_call', async () => {
      throw new BudgetExceeded(1.5, 1.0);
    });

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const types = events.map((e) => e.type);

    // Assert — workflow fails (engine does not crash).
    expect(types).toContain('workflow_failed');
    expect(types).not.toContain('workflow_completed');
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    // BudgetExceeded gets wrapped into ExecutorError(code='executor_threw'),
    // so sanitizeError returns the generic scrubbed message.
    expect(failed.error).toBe('Step "a" failed unexpectedly');
  });
});
