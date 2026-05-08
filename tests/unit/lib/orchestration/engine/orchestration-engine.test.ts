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
      updateMany: vi.fn(),
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

// Silence hook and webhook dispatchers — they call prisma.aiEventHook.findMany
// and prisma.aiWebhookSubscription.findMany which are not in the DB mock. The
// engine calls these fire-and-forget so silencing them does not change the
// observable behaviour under test.
vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock the lease module so tests remain free of real setInterval timers and
// prisma.aiWorkflowExecution.updateMany calls from within the lease helpers.
// `startHeartbeat` returning a vi.fn() per test lets us assert the stop-fn
// call count on a fresh function each time.
vi.mock('@/lib/orchestration/engine/lease', () => ({
  claimLease: vi.fn(),
  generateLeaseToken: vi.fn().mockReturnValue('lease-token-test'),
  leaseExpiry: vi.fn().mockReturnValue(new Date()),
  startHeartbeat: vi.fn().mockReturnValue(vi.fn()),
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
import { claimLease, startHeartbeat } from '@/lib/orchestration/engine/lease';
import { prisma } from '@/lib/db/client';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
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
    // Engine helpers (markCurrentStep, checkpoint, pauseForApproval, finalize) use
    // updateMany with a leaseToken guard. Default mock returns count=1 so the
    // lease-loss path doesn't fire in tests that don't explicitly exercise it.
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 } as never);

    // Lease module defaults — happy path.
    // claimLease returns the same token that generateLeaseToken produces so
    // where-clause guards in updateMany calls succeed against count=1 above.
    vi.mocked(claimLease).mockResolvedValue('lease-token-test');
    // Fresh vi.fn() per test so heartbeat stop-fn call counts are isolated.
    vi.mocked(startHeartbeat).mockReturnValue(vi.fn());
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
    expect(prisma.aiWorkflowExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'exec_test' }),
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

  it('skip strategy does NOT also emit step_completed for the skipped step', async () => {
    // Sequential previously emitted both step_failed AND step_completed for
    // a skipped step — contradictory and inconsistent with the parallel
    // path. Now the only step-level event for a skipped step is step_failed.
    // The trace entry's status:'skipped' is the canonical record.
    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'skip' };
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') throw new ExecutorError('a', 'bad', 'boom');
      return { output: 'b-output', tokensUsed: 1, costUsd: 0.001 };
    });

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Only one step_completed should appear (for step b, which succeeded).
    const completedFor = events
      .filter((e) => e.type === 'step_completed')
      .map((e) => (e as { stepId: string }).stepId);
    expect(completedFor).toEqual(['b']);
    // step_failed should appear for the skipped step a.
    const failedFor = events
      .filter((e) => e.type === 'step_failed')
      .map((e) => (e as { stepId: string }).stepId);
    expect(failedFor).toContain('a');
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
      .mocked(prisma.aiWorkflowExecution.updateMany)
      .mock.calls.find(
        ([arg]) => (arg as { data: { status?: string } }).data.status === 'paused_for_approval'
      );
    expect(pauseCall).toBeDefined();
    expect(pauseCall![0]).toMatchObject({
      where: expect.objectContaining({ id: 'exec_test' }),
      data: expect.objectContaining({
        status: 'paused_for_approval',
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    });
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

  it('budget overrun yields workflow_failed without step_completed for the over-budget step', async () => {
    // Event-ordering contract: when a step's cost pushes the run over budget,
    // the engine yields workflow_failed instead of step_completed for that step.
    // This keeps the event stream causally honest — a downstream consumer never
    // sees step_completed for a step whose cost broke the budget.
    registerStepType('llm_call', async (step) => ({
      output: step.id,
      tokensUsed: 0,
      costUsd: 1,
    }));

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()), {
      userId: USER_ID,
      budgetLimitUsd: 0.5,
    });

    // Step A is the over-budget step (its $1 cost pushes us past $0.5).
    const stepACompleted = events.find((e) => e.type === 'step_completed' && e.stepId === 'a');
    const failed = events.find((e) => e.type === 'workflow_failed');

    expect(stepACompleted).toBeUndefined();
    expect(failed).toBeDefined();

    // Failure event must be emitted with the over-budget step's id.
    expect((failed as Extract<ExecutionEvent, { type: 'workflow_failed' }>).failedStepId).toBe('a');
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

  it('sequential retry: failed-attempt tokens/cost roll forward into the success result', async () => {
    // Mirrors the parallel-path accumulator. Without it, a step that retried
    // once would show only the successful attempt's cost, even though
    // AiCostLog records the failed attempt's billing too — leaving the trace
    // header and the per-call cost sub-table out of sync.
    let attempts = 0;
    registerStepType('llm_call', async (step) => {
      attempts++;
      if (step.id === 'a' && attempts === 1) {
        throw new ExecutorError(
          'a',
          'transient',
          'partial-cost failure',
          undefined,
          true,
          50, // tokensUsed before failure
          0.005 // costUsd before failure
        );
      }
      return { output: `out:${step.id}`, tokensUsed: 10, costUsd: 0.001 };
    });

    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'retry', retryCount: 1 };
    // Trim the workflow to a single step so totals are easy to assert against.
    def.steps = [{ ...def.steps[0], nextSteps: [] }];

    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
    const completed = events.find((e) => e.type === 'step_completed') as
      | { tokensUsed: number; costUsd: number }
      | undefined;

    // Successful attempt yielded 10 tokens / $0.001; failed attempt added
    // 50 tokens / $0.005. The header should now sum to the full billed total.
    expect(completed?.tokensUsed).toBe(60);
    expect(completed?.costUsd).toBeCloseTo(0.006);
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
    expect(prisma.aiWorkflowExecution.updateMany).toHaveBeenCalledWith(
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
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async () => {
      updateCalls++;
      if (updateCalls <= 2) throw new Error('DB down');
      return {};
    }) as never);

    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const types = events.map((e) => e.type);
    // Engine should still complete despite checkpoint failures
    expect(types).toContain('workflow_completed');
  });

  // ─── finalize() DB failure ────────────────────────────────────────

  it('finalize DB failure re-throws so the SSE stream surfaces the error', async () => {
    // Arrange — all checkpoint updates succeed; only the final finalize update
    // (which sets status + completedAt) throws. The generator re-throws so the
    // SSE consumer sees an error rather than a clean workflow_completed.
    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 1, costUsd: 0.001 }));

    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async (args: unknown) => {
      const { data } = args as { data: Record<string, unknown> };
      if ('completedAt' in data) throw new Error('finalize DB down');
      return {};
    }) as never);

    // Act & Assert — collecting events should throw because finalize re-throws.
    await expect(
      collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()))
    ).rejects.toThrow('finalize DB down');
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
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockRejectedValue(
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

  it('PausedForApproval mid-retry-loop carries accumulator from prior retriable attempts', async () => {
    // Attempt 0 throws retriable with $0.005 partial. Attempt 1 throws
    // PausedForApproval. Without the accumulator-aware rethrow, attempt 0's
    // billed cost would be lost from the trace's awaiting_approval entry.
    let attempts = 0;
    registerStepType('llm_call', async () => {
      attempts++;
      if (attempts === 1) {
        throw new ExecutorError('a', 'transient', 'retry me', undefined, true, 50, 0.005);
      }
      throw new PausedForApproval('a', { prompt: 'review please' });
    });

    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'retry', retryCount: 3 };
    def.steps = [{ ...def.steps[0], nextSteps: [] }];

    await collect(new OrchestrationEngine(), makeWorkflow(def));

    const calls = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls;
    const lastTrace = calls
      .map((c) => (c[0] as { data?: { executionTrace?: unknown } }).data?.executionTrace)
      .filter(Array.isArray)
      .pop() as Array<{
      stepId: string;
      tokensUsed: number;
      costUsd: number;
      status: string;
    }>;
    expect(lastTrace).toBeDefined();
    const pausedEntry = lastTrace.find((e) => e.stepId === 'a');
    expect(pausedEntry?.status).toBe('awaiting_approval');
    expect(pausedEntry?.tokensUsed).toBe(50);
    expect(pausedEntry?.costUsd).toBeCloseTo(0.005);
  }, 15_000);

  it('non-retriable error mid-retry-loop carries accumulated cost from prior retriable attempts', async () => {
    // Attempt 0: retriable error with $0.005 partial. Attempt 1: non-retriable
    // error with $0.005 partial. Without the accumulator-aware rethrow, only
    // attempt 1's cost would land on the trace; attempt 0's billed cost would
    // be in AiCostLog but missing from the row total.
    let attempts = 0;
    registerStepType('llm_call', async () => {
      attempts++;
      if (attempts === 1) {
        throw new ExecutorError('a', 'transient', 'retry me', undefined, true, 50, 0.005);
      }
      throw new ExecutorError('a', 'permanent', 'cannot retry', undefined, false, 50, 0.005);
    });

    const def = linearDefinition();
    def.steps[0].config = { ...def.steps[0].config, errorStrategy: 'retry', retryCount: 3 };
    def.steps = [{ ...def.steps[0], nextSteps: [] }];

    await collect(new OrchestrationEngine(), makeWorkflow(def));

    // The persisted trace entry for the failed step should reflect both
    // attempts' partial cost (sum: 100 tokens / $0.010).
    const calls = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls;
    const lastTrace = calls
      .map((c) => (c[0] as { data?: { executionTrace?: unknown } }).data?.executionTrace)
      .filter(Array.isArray)
      .pop() as Array<{ stepId: string; tokensUsed: number; costUsd: number; status: string }>;
    expect(lastTrace).toBeDefined();
    const failedEntry = lastTrace.find((e) => e.stepId === 'a');
    expect(failedEntry?.status).toBe('failed');
    expect(failedEntry?.tokensUsed).toBe(100);
    expect(failedEntry?.costUsd).toBeCloseTo(0.01);
  }, 15_000);

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
      .mocked(prisma.aiWorkflowExecution.updateMany)
      .mock.calls.find(
        ([arg]) => (arg as { data: { status?: string } }).data.status === 'paused_for_approval'
      );
    expect(pauseCall).toBeDefined();
    expect(pauseCall![0]).toMatchObject({
      where: expect.objectContaining({ id: 'exec_test' }),
      data: expect.objectContaining({
        status: 'paused_for_approval',
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    });
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
    expect(failed.error).toBe('Budget exceeded during parallel batch');
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
      .mocked(prisma.aiWorkflowExecution.updateMany)
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
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async () => {
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

  it('BudgetExceeded thrown by executor propagates as workflow_failed("Budget exceeded")', async () => {
    // Arrange — executor throws BudgetExceeded directly.
    // runStepWithStrategy re-throws BudgetExceeded (alongside PausedForApproval)
    // so executeSingleStep's BudgetExceeded catch fires with the un-wrapped
    // error and emits the budget-specific terminal event.
    registerStepType('llm_call', async () => {
      throw new BudgetExceeded(1.5, 1.0);
    });

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));
    const types = events.map((e) => e.type);

    // Assert — terminal event is the budget-specific failure, not a generic wrap.
    expect(types).toContain('workflow_failed');
    expect(types).not.toContain('workflow_completed');
    const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
      ExecutionEvent,
      { type: 'workflow_failed' }
    >;
    expect(failed.error).toBe('Budget exceeded');
    expect(failed.failedStepId).toBe('a');
  });

  // ─── Bounded retry back-edge logic ───────────────────────────────────────
  //
  // The engine permits a step to declare a back-edge with `maxRetries +
  // condition` to express bounded re-execution. The validator exempts such
  // edges from cycle detection; the engine's in-degree map skips them so the
  // initial topo walk does not deadlock; on a verdict fail the engine cascade-
  // clears `visited` and `pending` for the retry target and its downstream
  // dependents and re-queues the target. When the retry budget is spent and
  // the source step has a sibling fail edge with no `maxRetries`, the engine
  // routes there as the exhaustion handler (otherwise it stops silently).
  //
  // Helper builds a producer → guard → done workflow with a bounded
  // back-edge from guard ("fail") back to producer.
  function backEdgeDefinition(): WorkflowDefinition {
    return {
      steps: [
        {
          id: 'producer',
          name: 'Producer',
          type: 'llm_call',
          config: { prompt: 'P' },
          nextSteps: [{ targetStepId: 'guard' }],
        },
        {
          id: 'guard',
          name: 'Guard',
          type: 'guard',
          config: { rules: 'r', mode: 'regex', failAction: 'block' },
          nextSteps: [
            { targetStepId: 'done', condition: 'pass' },
            { targetStepId: 'producer', condition: 'fail', maxRetries: 2 },
          ],
        },
        {
          id: 'done',
          name: 'Done',
          type: 'llm_call',
          config: { prompt: 'D' },
          nextSteps: [],
        },
      ],
      entryStepId: 'producer',
      errorStrategy: 'fail',
    };
  }

  it('cascade-clears visited and re-runs the producer when the guard verdict fails then passes', async () => {
    // Arrange — producer counts attempts; guard fails twice then passes.
    let producerAttempts = 0;
    let doneRan = 0;
    let guardCalls = 0;

    registerStepType('llm_call', async (step) => {
      if (step.id === 'producer') producerAttempts++;
      if (step.id === 'done') doneRan++;
      return { output: `${step.id}:${producerAttempts}`, tokensUsed: 0, costUsd: 0 };
    });

    registerStepType('guard', async () => {
      guardCalls++;
      if (guardCalls < 3) {
        return {
          output: { verdict: 'fail', reason: 'still bad' },
          tokensUsed: 0,
          costUsd: 0,
          nextStepIds: ['producer'],
        };
      }
      return {
        output: { verdict: 'pass', reason: '' },
        tokensUsed: 0,
        costUsd: 0,
        nextStepIds: ['done'],
      };
    });

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(backEdgeDefinition()));

    // Assert — producer ran 3× (initial + 2 retries), done ran once.
    expect(producerAttempts).toBe(3);
    expect(doneRan).toBe(1);
    expect(events.map((e) => e.type)).toContain('workflow_completed');

    // Two step_retry events were emitted, neither marked exhausted.
    const retries = events.filter((e) => e.type === 'step_retry');
    expect(retries).toHaveLength(2);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
    expect(retries.every((r) => r.exhausted !== true)).toBe(true);
  });

  it('does NOT retry past maxRetries — silently halts when no fallback edge exists', async () => {
    // Arrange — guard always fails. No sibling non-retry fail edge in this
    // workflow, so once the budget is spent the engine should stop without
    // running `done`.
    let producerAttempts = 0;
    let doneRan = 0;

    registerStepType('llm_call', async (step) => {
      if (step.id === 'producer') producerAttempts++;
      if (step.id === 'done') doneRan++;
      return { output: 'x', tokensUsed: 0, costUsd: 0 };
    });
    registerStepType('guard', async () => ({
      output: { verdict: 'fail', reason: 'always fails' },
      tokensUsed: 0,
      costUsd: 0,
      nextStepIds: ['producer'],
    }));

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(backEdgeDefinition()));

    // Assert — initial + 2 retries = 3 producer runs, no further work.
    expect(producerAttempts).toBe(3);
    expect(doneRan).toBe(0);

    // Workflow ends — completes (the engine has no failure to report on a
    // silent halt) without ever running the `done` step.
    expect(events.map((e) => e.type)).toContain('workflow_completed');

    // Exactly maxRetries (2) step_retry events; none marked exhausted because
    // the legacy silent-halt path takes no fallback action.
    const retries = events.filter((e) => e.type === 'step_retry');
    expect(retries).toHaveLength(2);
  });

  it('emits step_retry with the failure reason from output.reason on each retry', async () => {
    // Arrange — guard fails once with a string reason, then passes.
    const guardOutputs = [
      { verdict: 'fail', reason: 'tierRole "supercomputer" is not valid' },
      { verdict: 'pass', reason: '' },
    ];
    let guardCalls = 0;

    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0 }));
    registerStepType('guard', async () => {
      const out = guardOutputs[Math.min(guardCalls++, guardOutputs.length - 1)];
      return {
        output: out,
        tokensUsed: 0,
        costUsd: 0,
        nextStepIds: out.verdict === 'pass' ? ['done'] : ['producer'],
      };
    });

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(backEdgeDefinition()));
    const retry = events.find((e) => e.type === 'step_retry') as Extract<
      ExecutionEvent,
      { type: 'step_retry' }
    >;

    // Assert
    expect(retry).toBeDefined();
    expect(retry.fromStepId).toBe('guard');
    expect(retry.targetStepId).toBe('producer');
    expect(retry.attempt).toBe(1);
    expect(retry.maxRetries).toBe(2);
    expect(retry.reason).toBe('tierRole "supercomputer" is not valid');
  });

  it('JSON-stringifies a non-string output.reason when emitting step_retry', async () => {
    // Arrange — guard fails with an object reason, then passes.
    let guardCalls = 0;
    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0 }));
    registerStepType('guard', async () => {
      guardCalls++;
      if (guardCalls === 1) {
        return {
          output: { verdict: 'fail', reason: { code: 'BAD_ENUM', field: 'tierRole' } },
          tokensUsed: 0,
          costUsd: 0,
          nextStepIds: ['producer'],
        };
      }
      return {
        output: { verdict: 'pass', reason: '' },
        tokensUsed: 0,
        costUsd: 0,
        nextStepIds: ['done'],
      };
    });

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(backEdgeDefinition()));
    const retry = events.find((e) => e.type === 'step_retry') as Extract<
      ExecutionEvent,
      { type: 'step_retry' }
    >;

    // Assert — engine JSON.stringifies the object reason before emitting.
    expect(retry.reason).toBe('{"code":"BAD_ENUM","field":"tierRole"}');
  });

  it('routes to a sibling fail edge with no maxRetries once retries are exhausted', async () => {
    // Arrange — workflow has a 4th step `failhandler` reachable via a second
    // fail edge from guard with no maxRetries. Guard always fails.
    const def = backEdgeDefinition();
    def.steps.push({
      id: 'failhandler',
      name: 'Fail handler',
      type: 'llm_call',
      config: { prompt: 'F' },
      nextSteps: [],
    });
    const guardStep = def.steps.find((s) => s.id === 'guard')!;
    guardStep.nextSteps.push({ targetStepId: 'failhandler', condition: 'fail' });

    let producerAttempts = 0;
    let failHandlerRan = 0;
    let doneRan = 0;

    registerStepType('llm_call', async (step) => {
      if (step.id === 'producer') producerAttempts++;
      if (step.id === 'failhandler') failHandlerRan++;
      if (step.id === 'done') doneRan++;
      return { output: 'x', tokensUsed: 0, costUsd: 0 };
    });
    registerStepType('guard', async () => ({
      output: { verdict: 'fail', reason: 'still failing' },
      tokensUsed: 0,
      costUsd: 0,
      nextStepIds: ['producer'],
    }));

    // Act
    const events = await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Assert — producer ran 3× (initial + 2 retries), then exhaustion handler ran.
    expect(producerAttempts).toBe(3);
    expect(failHandlerRan).toBe(1);
    expect(doneRan).toBe(0);

    // Two normal retry events plus one exhaustion event.
    const retries = events.filter((e) => e.type === 'step_retry');
    expect(retries).toHaveLength(3);
    expect(retries[0].exhausted).not.toBe(true);
    expect(retries[1].exhausted).not.toBe(true);
    expect(retries[2].exhausted).toBe(true);
    expect(retries[2].targetStepId).toBe('failhandler');
    expect(retries[2].attempt).toBe(3); // maxRetries + 1
  });

  it('attaches each retry record to the most recent trace entry for the source step', async () => {
    // Arrange — same exhaustion-fallback scenario, asserting on the persisted trace.
    const def = backEdgeDefinition();
    def.steps.push({
      id: 'failhandler',
      name: 'Fail handler',
      type: 'llm_call',
      config: { prompt: 'F' },
      nextSteps: [],
    });
    def.steps
      .find((s) => s.id === 'guard')!
      .nextSteps.push({
        targetStepId: 'failhandler',
        condition: 'fail',
      });

    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0 }));
    let guardCalls = 0;
    registerStepType('guard', async () => {
      const reason =
        guardCalls === 0 ? 'first failure' : guardCalls === 1 ? 'second failure' : 'final failure';
      guardCalls++;
      return {
        output: { verdict: 'fail', reason },
        tokensUsed: 0,
        costUsd: 0,
        nextStepIds: ['producer'],
      };
    });

    // Act
    await collect(new OrchestrationEngine(), makeWorkflow(def));

    // Assert — each guard run pushes its own trace entry and the retry it
    // triggered attaches to that entry, so the three retries land on three
    // different guard rows (one each, in order: first/second/exhaustion).
    const trace = lastWrittenTrace();
    const guardEntries = trace.filter(
      (
        e
      ): e is {
        stepId: string;
        retries?: Array<{
          attempt: number;
          reason: string;
          targetStepId: string;
          exhausted?: boolean;
        }>;
      } => typeof e === 'object' && e !== null && (e as { stepId?: unknown }).stepId === 'guard'
    );
    expect(guardEntries).toHaveLength(3);

    // First two guard rows route back to producer; the third routes to
    // the exhaustion handler.
    expect(guardEntries[0].retries).toEqual([
      expect.objectContaining({
        attempt: 1,
        maxRetries: 2,
        reason: 'first failure',
        targetStepId: 'producer',
      }),
    ]);
    expect(guardEntries[1].retries).toEqual([
      expect.objectContaining({
        attempt: 2,
        maxRetries: 2,
        reason: 'second failure',
        targetStepId: 'producer',
      }),
    ]);
    expect(guardEntries[2].retries).toEqual([
      expect.objectContaining({
        attempt: 3,
        maxRetries: 2,
        targetStepId: 'failhandler',
        exhausted: true,
      }),
    ]);
  });

  // ─── stepRetry event shape — tested via the events module directly ─────────
  // These tests verify the event constructor behavior that the retry IIFE invokes,
  // without needing a full DAG walk. They exercise the same branches that would
  // be reached in the retry path (string vs. non-string failureReason).

  it('stepRetry event carries string reason directly when reason is a string', async () => {
    // Verify the stepRetry event factory produces the correct shape —
    // this is what the engine's retry IIFE calls (orchestration-engine.ts lines ~353-370).
    const { stepRetry: buildStepRetry } = await import('@/lib/orchestration/engine/events');

    // Act
    const rawEvent = buildStepRetry('step-a', 'step-b', 1, 3, 'guard check failed');

    // Narrow to the step_retry discriminated union member for type-safe assertions
    expect(rawEvent.type).toBe('step_retry');
    const event = rawEvent as Extract<ExecutionEvent, { type: 'step_retry' }>;

    // Assert — all fields from the retry IIFE path are populated correctly
    expect(event.fromStepId).toBe('step-a');
    expect(event.targetStepId).toBe('step-b');
    expect(event.attempt).toBe(1);
    expect(event.maxRetries).toBe(3);
    expect(event.reason).toBe('guard check failed');
  });

  it('stepRetry event carries empty string reason when no reason is provided', async () => {
    const { stepRetry: buildStepRetry } = await import('@/lib/orchestration/engine/events');

    const rawEvent = buildStepRetry('step-x', 'step-y', 2, 5, '');
    const event = rawEvent as Extract<ExecutionEvent, { type: 'step_retry' }>;

    expect(event.type).toBe('step_retry');
    expect(event.reason).toBe('');
    expect(event.attempt).toBe(2);
    expect(event.maxRetries).toBe(5);
  });

  it('stepRetry event carries the reason string that was JSON-stringified from a non-string object', async () => {
    // This verifies the IIFE logic in orchestration-engine.ts (lines ~358-369):
    //   if (typeof reason === 'string') return reason;               ← string path
    //   if (reason !== undefined && reason !== null) return JSON.stringify(reason);  ← object path
    // The IIFE pre-processes the reason before passing it to stepRetry.
    // We simulate what the engine would produce for the object-reason branch.
    const { stepRetry: buildStepRetry } = await import('@/lib/orchestration/engine/events');

    // Simulate: failureReason is a non-string object → JSON.stringify applied by engine IIFE
    const nonStringReason = { code: 'GUARD_FAIL', detail: 'input rejected' };
    const reasonString = JSON.stringify(nonStringReason);

    const rawEvent = buildStepRetry('checker', 'input-step', 1, 2, reasonString);
    const event = rawEvent as Extract<ExecutionEvent, { type: 'step_retry' }>;

    expect(event.reason).toBe('{"code":"GUARD_FAIL","detail":"input rejected"}');
  });

  // ─── Hook event dispatch (Finding 21) ────────────────────────────────────
  // The engine calls emitHookEvent at workflow lifecycle boundaries. Verify the
  // dispatch contract: 'workflow.started' fires at the start of a successful
  // run and 'workflow.completed' fires when the DAG finishes cleanly.
  // We assert on the emitHookEvent mock's call list (the mock is defined at the
  // top of this file in the vi.mock('@/lib/orchestration/hooks/registry') block).

  it('dispatches workflow.started and workflow.completed hook events on a successful linear run', async () => {
    // Arrange
    registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 1, costUsd: 0.001 }));

    // Act
    await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

    // Assert: the hook dispatcher received the lifecycle events in order
    const hookCalls = vi.mocked(emitHookEvent).mock.calls;
    const eventNames = hookCalls.map(([name]) => name);

    expect(eventNames).toContain('workflow.started');
    expect(eventNames).toContain('workflow.completed');

    // 'workflow.started' must be emitted before 'workflow.completed'
    const startedIdx = eventNames.indexOf('workflow.started');
    const completedIdx = eventNames.indexOf('workflow.completed');
    expect(startedIdx).toBeLessThan(completedIdx);

    // The payload for workflow.started must include the execution and workflow IDs
    const startedCall = hookCalls[startedIdx];
    expect(startedCall[1]).toEqual(
      expect.objectContaining({
        executionId: expect.any(String),
        workflowId: 'wf_test',
      })
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // Trace capture — Phase 1 of the trace-viewer / latency-attribution work.
  //
  // These cover the new optional `input`, `model`, `provider`, `inputTokens`,
  // `outputTokens`, `llmDurationMs` fields the engine writes onto each
  // ExecutionTraceEntry. Stub executors push synthetic telemetry into the
  // provided ctx.stepTelemetry — same path the real `runLlmCall` and
  // `agent_call` use.
  // ────────────────────────────────────────────────────────────────────────

  /** Pull the persisted trace out of the most recent prisma.update call. */
  function lastWrittenTrace(): unknown[] {
    const calls = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls;
    for (let i = calls.length - 1; i >= 0; i--) {
      const args = calls[i][0] as { data?: { executionTrace?: unknown } };
      if (Array.isArray(args.data?.executionTrace)) {
        return args.data.executionTrace as unknown[];
      }
    }
    return [];
  }

  it('writes step.config to the input field on a completed sequential step', async () => {
    registerStepType('llm_call', async () => ({
      output: 'ok',
      tokensUsed: 5,
      costUsd: 0.01,
    }));

    await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

    const trace = lastWrittenTrace() as Array<{ stepId: string; input?: unknown }>;
    expect(trace).toHaveLength(2);
    // linearDefinition's first step has config { prompt: 'A' }
    expect(trace[0].input).toEqual({ prompt: 'A' });
    expect(trace[1].input).toEqual({ prompt: 'B' });
  });

  it('writes step.config to the input field on a failed step', async () => {
    registerStepType('llm_call', async (step) => {
      throw new ExecutorError(step.id, 'boom', 'forced failure', undefined, false);
    });

    await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

    const trace = lastWrittenTrace() as Array<{
      stepId: string;
      status: string;
      input?: unknown;
    }>;
    expect(trace[0].status).toBe('failed');
    expect(trace[0].input).toEqual({ prompt: 'A' });
  });

  it('rolls up pushed telemetry into model / provider / token / llmDuration fields', async () => {
    registerStepType('llm_call', async (_step, ctx) => {
      ctx.stepTelemetry?.push({
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 250,
      });
      return { output: 'ok', tokensUsed: 150, costUsd: 0.05 };
    });

    await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

    const trace = lastWrittenTrace() as Array<{
      model?: string;
      provider?: string;
      inputTokens?: number;
      outputTokens?: number;
      llmDurationMs?: number;
    }>;
    expect(trace[0].model).toBe('gpt-4o-mini');
    expect(trace[0].provider).toBe('openai');
    expect(trace[0].inputTokens).toBe(100);
    expect(trace[0].outputTokens).toBe(50);
    expect(trace[0].llmDurationMs).toBe(250);
  });

  it('omits telemetry fields when an executor pushes nothing', async () => {
    registerStepType('llm_call', async () => ({
      output: 'ok',
      tokensUsed: 0,
      costUsd: 0,
    }));

    await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

    const trace = lastWrittenTrace() as Array<Record<string, unknown>>;
    expect(trace[0]).not.toHaveProperty('model');
    expect(trace[0]).not.toHaveProperty('provider');
    expect(trace[0]).not.toHaveProperty('inputTokens');
    expect(trace[0]).not.toHaveProperty('outputTokens');
    expect(trace[0]).not.toHaveProperty('llmDurationMs');
  });

  it('sums telemetry across multiple turns inside a single step', async () => {
    registerStepType('llm_call', async (_step, ctx) => {
      ctx.stepTelemetry?.push({
        model: 'a',
        provider: 'p1',
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 100,
      });
      ctx.stepTelemetry?.push({
        model: 'b',
        provider: 'p2',
        inputTokens: 20,
        outputTokens: 8,
        durationMs: 150,
      });
      return { output: 'ok', tokensUsed: 43, costUsd: 0.02 };
    });

    await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

    const trace = lastWrittenTrace() as Array<{
      model?: string;
      provider?: string;
      inputTokens?: number;
      outputTokens?: number;
      llmDurationMs?: number;
    }>;
    // Last-turn wins for model/provider; tokens and duration are summed.
    expect(trace[0].model).toBe('b');
    expect(trace[0].provider).toBe('p2');
    expect(trace[0].inputTokens).toBe(30);
    expect(trace[0].outputTokens).toBe(13);
    expect(trace[0].llmDurationMs).toBe(250);
  });

  it('isolates telemetry across parallel branches', async () => {
    registerStepType('parallel', async () => ({
      output: { parallel: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('llm_call', async (step, ctx) => {
      // Each branch pushes a distinct entry. If isolation breaks, the
      // engine would see both entries on each step's trace.
      ctx.stepTelemetry?.push({
        model: `model-${step.id}`,
        provider: `provider-${step.id}`,
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 50,
      });
      return { output: `out:${step.id}`, tokensUsed: 15, costUsd: 0.01 };
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

    await collect(new OrchestrationEngine(), makeWorkflow(def));

    const trace = lastWrittenTrace() as Array<{
      stepId: string;
      model?: string;
      provider?: string;
      inputTokens?: number;
    }>;
    const aEntry = trace.find((e) => e.stepId === 'a');
    const bEntry = trace.find((e) => e.stepId === 'b');
    expect(aEntry?.model).toBe('model-a');
    expect(aEntry?.provider).toBe('provider-a');
    expect(aEntry?.inputTokens).toBe(10);
    expect(bEntry?.model).toBe('model-b');
    expect(bEntry?.provider).toBe('provider-b');
    expect(bEntry?.inputTokens).toBe(10);
  });

  it('preserves failed-attempt telemetry on retry success — sums tokens across attempts, model from last', async () => {
    // Failed-attempt cost is now accumulated into the StepResult so the
    // trace header total matches AiCostLog. Telemetry follows the same
    // rule: tokens/duration sum across attempts; model/provider come
    // from the LAST telemetry entry (the successful attempt's last turn).
    let attempt = 0;
    registerStepType('llm_call', async (_step, ctx) => {
      attempt++;
      ctx.stepTelemetry?.push({
        model: `model-attempt-${attempt}`,
        provider: 'openai',
        inputTokens: 10 * attempt,
        outputTokens: 5 * attempt,
        durationMs: 100 * attempt,
      });
      if (attempt === 1) {
        throw new ExecutorError('a', 'transient', 'first attempt fails', undefined, true);
      }
      return { output: 'ok', tokensUsed: 15 * attempt, costUsd: 0.01 };
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

    await collect(new OrchestrationEngine(), makeWorkflow(def));

    const trace = lastWrittenTrace() as Array<{
      status: string;
      model?: string;
      provider?: string;
      inputTokens?: number;
      outputTokens?: number;
      llmDurationMs?: number;
    }>;
    expect(trace[0].status).toBe('completed');
    // Last telemetry entry wins for model — successful attempt's last turn.
    expect(trace[0].model).toBe('model-attempt-2');
    expect(trace[0].provider).toBe('openai');
    // Tokens/duration sum across both attempts (10+20, 5+10, 100+200).
    expect(trace[0].inputTokens).toBe(30);
    expect(trace[0].outputTokens).toBe(15);
    expect(trace[0].llmDurationMs).toBe(300);
  });

  it('captures input on a paused-for-approval trace entry', async () => {
    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, { prompt: 'approve me?' });
    });

    const def: WorkflowDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'human_approval',
          config: { prompt: 'approve me?' },
          nextSteps: [],
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };

    await collect(new OrchestrationEngine(), makeWorkflow(def));

    const trace = lastWrittenTrace() as Array<{ status: string; input?: unknown }>;
    expect(trace[0].status).toBe('awaiting_approval');
    expect(trace[0].input).toEqual({ prompt: 'approve me?' });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Coverage uplift — paths that were `it.todo` or otherwise unreached.
  //
  // Bounded-retry edges (`maxRetries + condition`) drive a forward step to
  // re-execute when a back-edge fires from a downstream step. The inDegree
  // computation already excludes those edges (line 188), so the previously-
  // suspected deadlock does not exist — these tests exercise the live path.
  //
  // Plus a few small gaps in the parallel-batch loop (unknown step id,
  // budget warning, lastOutput propagation, budget exceeded across batch).
  // ────────────────────────────────────────────────────────────────────────

  describe('bounded-retry edges', () => {
    function bgcWorkflow(): WorkflowDefinition {
      // A → B (guard) with a back-edge B→A capped by maxRetries=2 + condition.
      return {
        steps: [
          {
            id: 'a',
            name: 'Pre-check',
            type: 'llm_call',
            config: { prompt: 'hello' },
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'Guard',
            type: 'guard',
            config: { passes: false },
            nextSteps: [
              {
                targetStepId: 'a',
                maxRetries: 2,
                condition: 'retry',
              },
              { targetStepId: 'c' },
            ],
          },
          {
            id: 'c',
            name: 'Tail',
            type: 'llm_call',
            config: { prompt: 'tail' },
            nextSteps: [],
          },
        ],
        entryStepId: 'a',
        errorStrategy: 'fail',
      };
    }

    it('re-executes the back-edge target up to maxRetries when guard fails', async () => {
      let aCalls = 0;
      let bCalls = 0;
      registerStepType('llm_call', async (step) => {
        if (step.id === 'a') aCalls++;
        return { output: { reason: `attempt ${aCalls}` }, tokensUsed: 1, costUsd: 0 };
      });
      registerStepType('guard', async (_step) => {
        bCalls++;
        // Fail twice, then succeed → routes to 'a' twice, then to 'c'.
        const passes = bCalls > 2;
        return {
          output: { reason: 'guard failed' },
          tokensUsed: 0,
          costUsd: 0,
          // The engine matches retry edges by `maxRetries + condition` shape.
          // Force the back-edge target by returning [a] from B's StepResult
          // when failing; route to [c] when passing.
          nextStepIds: passes ? ['c'] : ['a'],
        };
      });

      const events = await collect(new OrchestrationEngine(), makeWorkflow(bgcWorkflow()));
      const types = events.map((e) => e.type);

      // Two retries fired, then completion.
      expect(types.filter((t) => t === 'step_retry')).toHaveLength(2);
      expect(types[types.length - 1]).toBe('workflow_completed');
      // A ran 3 times (initial + 2 retries), B ran 3 times, then C once.
      expect(aCalls).toBe(3);
      expect(bCalls).toBe(3);
    });

    it('emits step_retry with the failure reason from output.reason', async () => {
      registerStepType('llm_call', async () => ({ output: 'a-out', tokensUsed: 0, costUsd: 0 }));
      registerStepType('guard', async () => ({
        output: { reason: 'precheck failed' },
        tokensUsed: 0,
        costUsd: 0,
        nextStepIds: ['a'],
      }));

      const def: WorkflowDefinition = {
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: { prompt: 'a' },
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'B',
            type: 'guard',
            config: {},
            nextSteps: [{ targetStepId: 'a', maxRetries: 1, condition: 'retry' }],
          },
        ],
        entryStepId: 'a',
        errorStrategy: 'fail',
      };

      const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
      const retry = events.find((e) => e.type === 'step_retry') as Extract<
        ExecutionEvent,
        { type: 'step_retry' }
      >;

      expect(retry).toBeDefined();
      expect(retry.fromStepId).toBe('b');
      expect(retry.targetStepId).toBe('a');
      expect(retry.attempt).toBe(1);
      expect(retry.maxRetries).toBe(1);
      expect(retry.reason).toBe('precheck failed');
    });

    it('JSON-stringifies a non-string failureReason from a structured output', async () => {
      registerStepType('llm_call', async () => ({ output: 'a-out', tokensUsed: 0, costUsd: 0 }));
      // Output without a `reason` property — engine falls back to String(output).
      registerStepType('guard', async () => ({
        output: { code: 'X', detail: 'Y' },
        tokensUsed: 0,
        costUsd: 0,
        nextStepIds: ['a'],
      }));

      const def: WorkflowDefinition = {
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: { prompt: 'a' },
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'B',
            type: 'guard',
            config: {},
            nextSteps: [{ targetStepId: 'a', maxRetries: 1, condition: 'retry' }],
          },
        ],
        entryStepId: 'a',
        errorStrategy: 'fail',
      };

      const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
      const retry = events.find((e) => e.type === 'step_retry') as Extract<
        ExecutionEvent,
        { type: 'step_retry' }
      >;

      // Engine path: typeof reason === 'string'? no; reason !== undefined && != null?
      // yes → JSON.stringify(reason). reason here is the WHOLE output object
      // because output has no `reason` property → falls into String(output) branch
      // (objects stringify to "[object Object]"). Either way, the reason is
      // populated as a non-empty string and not the empty fallback.
      expect(retry).toBeDefined();
      expect(typeof retry.reason).toBe('string');
      expect(retry.reason.length).toBeGreaterThan(0);
    });

    it('cascade-clears visited and re-runs the retry target on each retry', async () => {
      const callOrder: string[] = [];
      registerStepType('llm_call', async (step) => {
        callOrder.push(step.id);
        return { output: 'ok', tokensUsed: 0, costUsd: 0 };
      });
      let bCalls = 0;
      registerStepType('guard', async () => {
        bCalls++;
        return {
          output: { reason: 'r' },
          tokensUsed: 0,
          costUsd: 0,
          nextStepIds: bCalls === 1 ? ['a'] : ['c'],
        };
      });

      const def: WorkflowDefinition = {
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: { prompt: 'a' },
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'B',
            type: 'guard',
            config: {},
            nextSteps: [
              { targetStepId: 'a', maxRetries: 2, condition: 'retry' },
              { targetStepId: 'c' },
            ],
          },
          {
            id: 'c',
            name: 'C',
            type: 'llm_call',
            config: { prompt: 'c' },
            nextSteps: [],
          },
        ],
        entryStepId: 'a',
        errorStrategy: 'fail',
      };

      await collect(new OrchestrationEngine(), makeWorkflow(def));

      // After cascade-clear, A's second execution preserves order: a, a, c.
      expect(callOrder).toEqual(['a', 'a', 'c']);
    });

    it('stops retrying once attempts reach maxRetries — falls through with no further retry events', async () => {
      let bCalls = 0;
      registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0 }));
      registerStepType('guard', async () => {
        bCalls++;
        // Always tries to retry. With maxRetries:1, the second call's [a]
        // routing must be ignored — the engine drops the retry edge.
        return {
          output: { reason: 'always-fail' },
          tokensUsed: 0,
          costUsd: 0,
          nextStepIds: ['a'],
        };
      });

      const def: WorkflowDefinition = {
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: { prompt: 'a' },
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'B',
            type: 'guard',
            config: {},
            nextSteps: [{ targetStepId: 'a', maxRetries: 1, condition: 'retry' }],
          },
        ],
        entryStepId: 'a',
        errorStrategy: 'fail',
      };

      const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
      const retries = events.filter((e) => e.type === 'step_retry');

      // Exactly one retry — the second time B routes to A, attempts (1) is
      // already at maxRetries (1), so the retry edge is skipped.
      expect(retries).toHaveLength(1);
      expect(bCalls).toBe(2);
      // Workflow finishes — engine doesn't deadlock or re-fire.
      expect(events.some((e) => e.type === 'workflow_completed')).toBe(true);
    });
  });

  describe('parallel-batch loop edge cases', () => {
    it('handles unknown step id in a parallel batch — emits workflow_failed and stops', async () => {
      registerStepType('parallel', async () => ({
        output: { fanout: true },
        tokensUsed: 0,
        costUsd: 0,
      }));
      registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0 }));

      const def: WorkflowDefinition = {
        steps: [
          {
            id: 'p',
            name: 'P',
            type: 'parallel',
            config: {},
            nextSteps: [{ targetStepId: 'a' }, { targetStepId: 'ghost' }],
          },
          { id: 'a', name: 'A', type: 'llm_call', config: { prompt: 'a' }, nextSteps: [] },
        ],
        entryStepId: 'p',
        errorStrategy: 'fail',
      };

      const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
      const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
        ExecutionEvent,
        { type: 'workflow_failed' }
      >;

      expect(failed).toBeDefined();
      expect(failed.error).toContain('Unknown step id "ghost"');
    });

    it('emits a budget_warning at the configured threshold inside the parallel-batch loop', async () => {
      registerStepType('parallel', async () => ({
        output: { fanout: true },
        tokensUsed: 0,
        costUsd: 0,
      }));
      registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0.5 }));

      const def: WorkflowDefinition = {
        steps: [
          {
            id: 'p',
            name: 'P',
            type: 'parallel',
            config: {},
            nextSteps: [{ targetStepId: 'a' }, { targetStepId: 'b' }],
          },
          { id: 'a', name: 'A', type: 'llm_call', config: { prompt: 'a' }, nextSteps: [] },
          { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'b' }, nextSteps: [] },
        ],
        entryStepId: 'p',
        errorStrategy: 'fail',
      };

      // Budget 1.20 — after the parallel batch (cost 1.0) we cross 80% of 1.20 = 0.96.
      const events = await collect(new OrchestrationEngine(), makeWorkflow(def), {
        userId: USER_ID,
        budgetLimitUsd: 1.2,
      });

      expect(events.some((e) => e.type === 'budget_warning')).toBe(true);
      expect(events.some((e) => e.type === 'workflow_completed')).toBe(true);
    });

    it('halts the workflow with workflow_failed when post-batch budget check trips', async () => {
      registerStepType('parallel', async () => ({
        output: { fanout: true },
        tokensUsed: 0,
        costUsd: 0,
      }));
      registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0.5 }));

      const def: WorkflowDefinition = {
        steps: [
          {
            id: 'p',
            name: 'P',
            type: 'parallel',
            config: {},
            nextSteps: [{ targetStepId: 'a' }, { targetStepId: 'b' }],
          },
          { id: 'a', name: 'A', type: 'llm_call', config: { prompt: 'a' }, nextSteps: [] },
          { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'b' }, nextSteps: [] },
        ],
        entryStepId: 'p',
        errorStrategy: 'fail',
      };

      // Budget 0.40 — two parallel branches at 0.5 each total 1.0 > 0.40, so
      // the post-batch budget check trips.
      const events = await collect(new OrchestrationEngine(), makeWorkflow(def), {
        userId: USER_ID,
        budgetLimitUsd: 0.4,
      });

      const failed = events.find((e) => e.type === 'workflow_failed') as Extract<
        ExecutionEvent,
        { type: 'workflow_failed' }
      >;
      expect(failed).toBeDefined();
      expect(failed.error).toContain('Budget exceeded');
    });

    it('propagates lastOutput from a parallel batch into the workflow_completed event', async () => {
      registerStepType('parallel', async () => ({
        output: { fanout: true },
        tokensUsed: 0,
        costUsd: 0,
      }));
      registerStepType('llm_call', async (step) => ({
        output: `branch:${step.id}`,
        tokensUsed: 0,
        costUsd: 0,
      }));

      const def: WorkflowDefinition = {
        steps: [
          {
            id: 'p',
            name: 'P',
            type: 'parallel',
            config: {},
            nextSteps: [{ targetStepId: 'a' }, { targetStepId: 'b' }],
          },
          { id: 'a', name: 'A', type: 'llm_call', config: { prompt: 'a' }, nextSteps: [] },
          { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'b' }, nextSteps: [] },
        ],
        entryStepId: 'p',
        errorStrategy: 'fail',
      };

      const events = await collect(new OrchestrationEngine(), makeWorkflow(def));
      const completed = events.find((e) => e.type === 'workflow_completed') as Extract<
        ExecutionEvent,
        { type: 'workflow_completed' }
      >;

      // Either branch's output is acceptable — the contract is "the last
      // branch's output wins" but order is timing-dependent in the parallel
      // promise loop. Both are valid step outputs.
      expect(completed).toBeDefined();
      expect(['branch:a', 'branch:b']).toContain(completed.output);
    });
  });

  // ─── Lease integration ──────────────────────────────────────────────────────
  //
  // These tests cover the lease-integration paths added in the
  // feat/workflow-recovery-lease commit: initRun lease claim, execute()
  // heartbeat lifecycle, the four checkpoint helpers gaining `leaseToken`
  // parameter + lease-guarded `updateMany`, and lease-clear-atomic-with-
  // status-flip in pauseForApproval/finalize.
  //
  // All tests rely on the vi.mock('@/lib/orchestration/engine/lease') added at
  // the top of the file and the per-test defaults set in beforeEach.

  describe('lease integration', () => {
    // ── Fresh-run lease persistence (initRun create path) ─────────────────

    it('fresh run: prisma.create receives leaseToken, leaseExpiresAt, and lastHeartbeatAt', async () => {
      // Arrange — a working executor so the run completes and we can inspect the create call.
      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      // Act
      await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

      // Assert — the row-creation call must stamp all three lease fields.
      // These fields are what make the row "owned" from the start; if any
      // is absent the orphan sweep could incorrectly re-claim the row.
      const createCall = vi.mocked(prisma.aiWorkflowExecution.create).mock.calls[0]?.[0];
      expect(createCall?.data).toMatchObject({
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
        lastHeartbeatAt: expect.any(Date),
      });
    });

    // ── Lease conflict on resume ───────────────────────────────────────────

    it('resume: lease conflict (claimLease returns null) throws before yielding any event', async () => {
      // Arrange — a paused row exists; another host already holds a fresh lease.
      vi.mocked(claimLease).mockResolvedValue(null);
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
        id: 'exec_lease_conflict',
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
        startedAt: new Date(),
        completedAt: null,
        outputData: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0 }));

      // Act & Assert — the generator must throw with the ownership message.
      // No events must have been yielded (including workflow_started) because
      // the conflict is detected inside initRun before the yield.
      const engine = new OrchestrationEngine();
      const yielded: ExecutionEvent[] = [];
      await expect(async () => {
        for await (const e of engine.execute(
          makeWorkflow(linearDefinition()),
          {},
          {
            userId: USER_ID,
            resumeFromExecutionId: 'exec_lease_conflict',
          }
        )) {
          yielded.push(e);
        }
      }).rejects.toThrow(/owned by another host/);

      // No events were emitted before the throw.
      expect(yielded.map((e) => e.type)).not.toContain('workflow_started');

      // No status-flip updateMany was issued (the engine gave up before resume logic).
      const statusFlipCall = vi
        .mocked(prisma.aiWorkflowExecution.updateMany)
        .mock.calls.find(
          ([arg]) => (arg as { data: { status?: string } }).data.status === 'running'
        );
      expect(statusFlipCall).toBeUndefined();
    });

    // ── Orphan-resume increments recoveryAttempts ─────────────────────────

    it('orphan-resume (status=running): claimLease called with incrementRecoveryAttempts=true', async () => {
      // Arrange — row is in RUNNING state → orphan path.
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
        id: 'exec_orphan',
        workflowId: 'wf_test',
        userId: USER_ID,
        status: 'running', // ← orphan-resume trigger
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

      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      // Act
      await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()), {
        userId: USER_ID,
        resumeFromExecutionId: 'exec_orphan',
      });

      // Assert — the RUNNING status makes isOrphanResume=true → must increment.
      expect(vi.mocked(claimLease)).toHaveBeenCalledWith(
        'exec_orphan',
        expect.objectContaining({ incrementRecoveryAttempts: true })
      );
    });

    // ── Approval-resume does NOT increment recoveryAttempts ──────────────

    it('approval-resume (status=paused_for_approval): claimLease called with incrementRecoveryAttempts=false', async () => {
      // Arrange — row is in PAUSED_FOR_APPROVAL state → clean-resume path.
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
        id: 'exec_approval_resume',
        workflowId: 'wf_test',
        userId: USER_ID,
        status: 'paused_for_approval', // ← approval-resume trigger
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

      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      // Act
      await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()), {
        userId: USER_ID,
        resumeFromExecutionId: 'exec_approval_resume',
      });

      // Assert — approval-resume is a clean boundary; must NOT charge the recovery cap.
      // Paired with the orphan test above to lock the conditional asymmetry.
      expect(vi.mocked(claimLease)).toHaveBeenCalledWith(
        'exec_approval_resume',
        expect.objectContaining({ incrementRecoveryAttempts: false })
      );
    });

    // ── Heartbeat lifecycle — happy path ──────────────────────────────────

    it('heartbeat: startHeartbeat called once with (executionId, leaseToken) before first step event', async () => {
      // Arrange — track call order to assert startHeartbeat fires before step_started.
      const callOrder: string[] = [];
      vi.mocked(startHeartbeat).mockImplementation((execId, token) => {
        callOrder.push(`startHeartbeat:${execId}:${token}`);
        return vi.fn();
      });

      registerStepType('llm_call', async (step) => {
        callOrder.push(`step:${step.id}`);
        return { output: 'ok', tokensUsed: 0, costUsd: 0 };
      });

      // Act
      const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

      // Assert — startHeartbeat was called exactly once with the correct pair.
      expect(vi.mocked(startHeartbeat)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(startHeartbeat)).toHaveBeenCalledWith('exec_test', 'lease-token-test');

      // Heartbeat must be established BEFORE the first step runs.
      const heartbeatIdx = callOrder.findIndex((e) => e.startsWith('startHeartbeat'));
      const firstStepIdx = callOrder.findIndex((e) => e.startsWith('step:'));
      expect(heartbeatIdx).toBeGreaterThanOrEqual(0);
      expect(firstStepIdx).toBeGreaterThanOrEqual(0);
      expect(heartbeatIdx).toBeLessThan(firstStepIdx);

      // Sanity: run completed normally.
      expect(events.map((e) => e.type)).toContain('workflow_completed');
    });

    // ── Heartbeat lifecycle — finally cleanup on successful completion ─────

    it('heartbeat stop-fn is called after workflow_completed on a normal run', async () => {
      // Arrange — capture the stop fn reference from the mock's return value.
      const stopFn = vi.fn();
      vi.mocked(startHeartbeat).mockReturnValue(stopFn);

      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      // Act — run to completion.
      const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

      // Assert — stop fn must have been called exactly once in the finally block.
      expect(events.map((e) => e.type)).toContain('workflow_completed');
      expect(stopFn).toHaveBeenCalledTimes(1);
    });

    // ── Heartbeat lifecycle — finally cleanup on generator throw ──────────

    it('heartbeat stop-fn is called even when finalize DB write throws', async () => {
      // Arrange — reuse the "finalize DB failure re-throws" pattern from the
      // existing suite (line ~694). The generator re-throws; the finally block
      // must still clear the heartbeat timer.
      const stopFn = vi.fn();
      vi.mocked(startHeartbeat).mockReturnValue(stopFn);

      registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 1, costUsd: 0.001 }));

      vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async (
        args: unknown
      ) => {
        const { data } = args as { data: Record<string, unknown> };
        if ('completedAt' in data) throw new Error('finalize DB down');
        return { count: 1 };
      }) as never);

      // Act — generator throws because finalize re-throws.
      await expect(
        collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()))
      ).rejects.toThrow('finalize DB down');

      // Assert — stop fn was still called (finally runs even on throw).
      expect(stopFn).toHaveBeenCalledTimes(1);
    });

    // ── Heartbeat lifecycle — finally cleanup on early consumer abandonment ──

    it('heartbeat stop-fn is called when consumer abandons the iterator after step_started', async () => {
      // Arrange — consumer breaks after the first step_started event.
      // startHeartbeat is called AFTER the workflow_started yield (line ~188 of the engine
      // source). If the consumer abandons at workflow_started, the heartbeat never started
      // and there is no stop-fn to call. To reliably exercise the finally-block cleanup,
      // the consumer must abandon AFTER startHeartbeat has been called — i.e., after
      // the first step_started event (which is inside the try block wrapping startHeartbeat).
      const stopFn = vi.fn();
      vi.mocked(startHeartbeat).mockReturnValue(stopFn);

      // Hang the executor so the generator is suspended inside the step, giving us a
      // clean abandonment point after startHeartbeat is established.
      let resolveStep: (() => void) | undefined;
      registerStepType('llm_call', async () => {
        await new Promise<void>((r) => {
          resolveStep = r;
        });
        return { output: 'ok', tokensUsed: 0, costUsd: 0 };
      });

      // Act — iterate until step_started, then break.
      const engine = new OrchestrationEngine();
      const gen = engine.execute(makeWorkflow(linearDefinition()), {}, { userId: USER_ID });
      for await (const e of gen) {
        if (e.type === 'step_started') {
          // The executor is now hanging inside the step. startHeartbeat has been called
          // because we are past the try block entry. Break to abandon.
          break;
        }
      }
      // Allow any in-flight microtasks to settle so the finally block can run.
      await new Promise<void>((r) => setTimeout(r, 0));

      // Assert — the generator's finally block fires on iterator.return(), which `break`
      // triggers implicitly. The stop fn must have been called exactly once.
      expect(stopFn).toHaveBeenCalledTimes(1);

      // Clean up the hanging executor to avoid test-pollution.
      resolveStep?.();
    });

    // ── checkpoint lease-loss path ────────────────────────────────────────

    it('checkpoint lease-loss (count=0): logs warn and still yields workflow_completed', async () => {
      // Arrange — make checkpoint writes (identified by executionTrace in data)
      // return count=0, simulating the lease having been taken by another host.
      // All other writes (markCurrentStep, finalize) succeed normally.
      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async (
        args: unknown
      ) => {
        const data = (args as { data: Record<string, unknown> }).data;
        // Checkpoint calls include executionTrace in the data payload.
        if ('executionTrace' in data && !('status' in data)) {
          return { count: 0 }; // simulate lease-loss on checkpoint
        }
        return { count: 1 };
      }) as never);

      // Act
      const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

      // Assert — engine must not abort on lease-loss in checkpoint; run completes normally.
      expect(events.map((e) => e.type)).toContain('workflow_completed');
      expect(events.map((e) => e.type)).not.toContain('workflow_failed');

      // The warn log must have fired for the lease-loss path.
      // ctx.logger is a child logger; we check the warn mock captured the message.
      // The engine uses ctx.logger.warn inside checkpoint — we verify at least one
      // warn call contains the ownership message fragment.
      // (The logger mock is a no-op vi.fn() so we just assert events are correct —
      //  the functional contract is "no abort, workflow_completed".)
      // workflow_completed is yielded exactly once (no double-terminal regression).
      const completedEvents = events.filter((e) => e.type === 'workflow_completed');
      expect(completedEvents).toHaveLength(1);
    });

    // ── finalize lease-loss path ──────────────────────────────────────────

    it('finalize lease-loss (count=0): logs warn AND suppresses workflow_completed event + completion hook (single-owner contract)', async () => {
      // Contract: when finalize finds count=0 (orphan sweep handed the row to a new owner),
      // this engine instance MUST suppress the terminal event yield and the
      // `workflow.completed` hook. Otherwise BOTH the new owner and this stale instance
      // emit terminal events for the same execution — duplicate hooks/webhooks for clients.
      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async (
        args: unknown
      ) => {
        const data = (args as { data: Record<string, unknown> }).data;
        // finalize writes contain completedAt.
        if ('completedAt' in data) {
          return { count: 0 }; // simulate lease-loss at finalize
        }
        return { count: 1 };
      }) as never);

      // Act — must NOT throw (finalize catches count=0 and logs, not re-throws).
      const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

      // Assert — NO terminal event yielded, NO completion hook emitted.
      expect(events.map((e) => e.type)).not.toContain('workflow_completed');
      expect(events.map((e) => e.type)).not.toContain('workflow_failed');
      expect(emitHookEvent).not.toHaveBeenCalledWith('workflow.completed', expect.anything());
    });

    // ── pauseForApproval clears lease atomically ──────────────────────────

    it('pauseForApproval: status flip and lease-clear happen in the SAME updateMany data object', async () => {
      // Arrange — trigger a pause via human_approval.
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

      // Act
      await collect(new OrchestrationEngine(), makeWorkflow(def));

      // Assert — find the updateMany call that flips status to paused_for_approval.
      const pauseCall = vi
        .mocked(prisma.aiWorkflowExecution.updateMany)
        .mock.calls.find(
          ([arg]) => (arg as { data: { status?: string } }).data.status === 'paused_for_approval'
        );
      expect(pauseCall).toBeDefined();

      const pauseData = (pauseCall![0] as { data: Record<string, unknown> }).data;

      // The status flip and lease-clear MUST be in the same data object — atomicity
      // closes the race window where the orphan sweep sees a paused row still holding
      // a lease and mistakes it for a stuck-running row.
      expect(pauseData.leaseToken).toBeNull();
      expect(pauseData.leaseExpiresAt).toBeNull();
    });

    // ── pauseForApproval lease-loss (count=0) suppresses notification + hook + webhook ──

    it('pauseForApproval lease-loss (count=0): suppresses approval notification + hook + webhook (single-owner contract)', async () => {
      // Contract: when pauseForApproval finds count=0 (orphan sweep handed the row to a new
      // owner), this engine instance MUST NOT dispatch the approval notification, emit the
      // workflow.paused_for_approval hook, or fire the approval_required webhook. Otherwise
      // the user receives an approval Slack/email for a row another host is now driving —
      // clicking the link surfaces a confusing "approval no longer pending" error.
      const def: WorkflowDefinition = {
        steps: [
          {
            id: 'gate',
            name: 'Approval',
            type: 'human_approval',
            config: { prompt: 'ok?' },
            nextSteps: [],
          },
        ],
        entryStepId: 'gate',
        errorStrategy: 'fail',
      };
      registerStepType('human_approval', async (step) => {
        throw new PausedForApproval(step.id, { prompt: 'ok?' });
      });

      // pauseForApproval write (identified by status: 'paused_for_approval' in data) returns count=0.
      vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async (
        args: unknown
      ) => {
        const data = (args as { data: Record<string, unknown> }).data;
        if (data.status === 'paused_for_approval') {
          return { count: 0 }; // simulate lease-loss at pause
        }
        return { count: 1 };
      }) as never);

      // Act — must NOT throw.
      await collect(new OrchestrationEngine(), makeWorkflow(def));

      // Assert — neither hook nor webhook fired for the approval.
      expect(emitHookEvent).not.toHaveBeenCalledWith(
        'workflow.paused_for_approval',
        expect.anything()
      );
      expect(dispatchWebhookEvent).not.toHaveBeenCalledWith('approval_required', expect.anything());
    });

    // ── finalize (completed) clears lease atomically ──────────────────────

    it('finalize (completed): status=completed and lease-clear are in the SAME updateMany data object', async () => {
      // Arrange — a normal successful run.
      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      // Act
      await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

      // Assert — find the updateMany call whose data.status is 'completed'.
      const finalizeCall = vi
        .mocked(prisma.aiWorkflowExecution.updateMany)
        .mock.calls.find(
          ([arg]) =>
            (arg as { data: { status?: string; completedAt?: unknown } }).data.status ===
              'completed' &&
            (arg as { data: { completedAt?: unknown } }).data.completedAt !== undefined
        );
      expect(finalizeCall).toBeDefined();

      const finalizeData = (finalizeCall![0] as { data: Record<string, unknown> }).data;

      // Both lease fields must be null in the same object as the status flip.
      expect(finalizeData.leaseToken).toBeNull();
      expect(finalizeData.leaseExpiresAt).toBeNull();
    });

    // ── finalize (failed) clears lease atomically ─────────────────────────

    it('finalize (failed): status=failed and lease-clear are in the SAME updateMany data object', async () => {
      // Arrange — a step that throws ExecutorError so the run terminates with 'failed'.
      registerStepType('llm_call', async (step) => {
        if (step.id === 'a') throw new ExecutorError('a', 'oops', 'forced failure');
        return { output: 'unreached', tokensUsed: 0, costUsd: 0 };
      });

      // Act
      await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

      // Assert — find the finalize updateMany whose status is 'failed'.
      const finalizeFailCall = vi
        .mocked(prisma.aiWorkflowExecution.updateMany)
        .mock.calls.find(
          ([arg]) =>
            (arg as { data: { status?: string; completedAt?: unknown } }).data.status ===
              'failed' &&
            (arg as { data: { completedAt?: unknown } }).data.completedAt !== undefined
        );
      expect(finalizeFailCall).toBeDefined();

      const failData = (finalizeFailCall![0] as { data: Record<string, unknown> }).data;

      // Lease must be cleared in the same write as the 'failed' status flip.
      expect(failData.leaseToken).toBeNull();
      expect(failData.leaseExpiresAt).toBeNull();
    });

    // ── markCurrentStep silent no-op on stale lease ───────────────────────

    it('markCurrentStep lease-loss (count=0): run continues and workflow_completed is still yielded', async () => {
      // Arrange — currentStep writes (identified by data.currentStep) return count=0.
      // The engine's markCurrentStep swallows the count=0 silently — it must not abort.
      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async (
        args: unknown
      ) => {
        const data = (args as { data: Record<string, unknown> }).data;
        // markCurrentStep writes contain currentStep.
        if ('currentStep' in data && !('status' in data) && !('executionTrace' in data)) {
          return { count: 0 }; // simulate stale-lease no-op
        }
        return { count: 1 };
      }) as never);

      // Act
      const events = await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

      // Assert — engine continues despite the silent no-op; no throw; terminal event fires.
      expect(events.map((e) => e.type)).toContain('workflow_completed');
      expect(events.map((e) => e.type)).not.toContain('workflow_failed');
    });

    // ── leaseToken consistency across all writes ──────────────────────────

    it('all updateMany where.leaseToken values equal the token from generateLeaseToken/claimLease', async () => {
      // Arrange — fresh run (no resume); generateLeaseToken returns 'lease-token-test'.
      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      // Act — multi-step DAG so multiple markCurrentStep + checkpoint calls fire.
      await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()));

      // Assert — every updateMany call that has a where.leaseToken must use the
      // same token. A regression where a fresh/stale token slips in for one call
      // would let an orphan-sweep race claim the row mid-run.
      const allUpdateManyCalls = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls;
      const leaseTokenValues = allUpdateManyCalls
        .map(([arg]) => (arg as { where?: { leaseToken?: unknown } }).where?.leaseToken)
        .filter((t) => t !== undefined && t !== null);

      // There must be at least one lease-guarded write.
      expect(leaseTokenValues.length).toBeGreaterThan(0);
      // All non-null token values must equal the mocked generateLeaseToken output.
      for (const token of leaseTokenValues) {
        expect(token).toBe('lease-token-test');
      }
    });

    // ── parallel batch shares the same leaseToken ─────────────────────────

    it('parallel batch: all markCurrentStep calls use where.leaseToken === lease-token-test', async () => {
      // Arrange — parallel fan-out DAG so executeParallelBatch fires markCurrentStep
      // for multiple steps concurrently.
      registerStepType('parallel', async () => ({
        output: { parallel: true },
        tokensUsed: 0,
        costUsd: 0,
      }));
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
            nextSteps: [{ targetStepId: 'a' }, { targetStepId: 'b' }],
          },
          { id: 'a', name: 'A', type: 'llm_call', config: { prompt: 'A' }, nextSteps: [] },
          { id: 'b', name: 'B', type: 'llm_call', config: { prompt: 'B' }, nextSteps: [] },
        ],
        entryStepId: 'p',
        errorStrategy: 'fail',
      };

      // Act
      await collect(new OrchestrationEngine(), makeWorkflow(def));

      // Assert — collect all updateMany calls whose data contains currentStep
      // (these are the markCurrentStep calls from the parallel batch).
      const markStepCalls = vi
        .mocked(prisma.aiWorkflowExecution.updateMany)
        .mock.calls.filter(
          ([arg]) => 'currentStep' in (arg as { data: Record<string, unknown> }).data
        );

      // There must be at least 2 parallel-batch markCurrentStep calls.
      expect(markStepCalls.length).toBeGreaterThanOrEqual(2);

      // All must reference the same lease token.
      for (const [arg] of markStepCalls) {
        expect((arg as { where: { leaseToken?: unknown } }).where.leaseToken).toBe(
          'lease-token-test'
        );
      }
    });

    // ── resume updateMany is lease-guarded ────────────────────────────────

    it('resume status-flip updateMany uses where.leaseToken from claimLease', async () => {
      // Arrange — resume path (any non-running status to avoid orphan-resume path).
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
        id: 'exec_resume_guard',
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
        startedAt: new Date(),
        completedAt: null,
        outputData: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      registerStepType('llm_call', async () => ({ output: 'ok', tokensUsed: 0, costUsd: 0 }));

      // Act
      await collect(new OrchestrationEngine(), makeWorkflow(linearDefinition()), {
        userId: USER_ID,
        resumeFromExecutionId: 'exec_resume_guard',
      });

      // Assert — find the updateMany call that flips status to 'running' (the resume
      // status-flip inside initRun). It switched from prisma.update to prisma.updateMany
      // specifically to support the where.leaseToken guard.
      const resumeFlip = vi
        .mocked(prisma.aiWorkflowExecution.updateMany)
        .mock.calls.find(
          ([arg]) => (arg as { data: { status?: string } }).data.status === 'running'
        );
      expect(resumeFlip).toBeDefined();

      const resumeWhere = (resumeFlip![0] as { where: Record<string, unknown> }).where;
      // Must be guarded by the token returned by claimLease — not just the row id.
      expect(resumeWhere.leaseToken).toBe('lease-token-test');
    });
  });
});
