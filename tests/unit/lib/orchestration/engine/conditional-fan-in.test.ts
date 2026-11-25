/**
 * The engine's walk where a step has edges in from steps that may not all
 * run (t-1077), and a failure step whose notice can't be sent (t-1078).
 *
 * t-1077: the provider model audit's `report_validation_failure` has `fail`
 * edges from two guards. When the first guard gave up after its retries the
 * second never ran, and the engine waited on it forever: "Workflow
 * deadlocked: steps [report_validation_failure] have unmet dependencies". The
 * engine now marks a step it can no longer reach as untaken, and a join
 * counts it as settled. A join after a parallel step still waits for every
 * branch, because each branch was taken.
 *
 * t-1078: that failure step is a `send_notification` with
 * `terminalStatus: 'failed'` and `errorStrategy: 'skip'`. A refused email was
 * skipped and the run recorded completed. It now ends failed with the step's
 * reason, and the trace keeps the delivery error.
 *
 * Executors are stubs, except `send_notification` in the template runs, which
 * is the real executor with only the email provider mocked.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before the engine import) ──────────────────────────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  withContext: vi.fn(),
}));
mockLogger.withContext.mockReturnValue(mockLogger);

vi.mock('@/lib/logging', () => ({
  createLogger: vi.fn(() => mockLogger),
  logger: mockLogger,
}));

vi.mock('@/lib/db/client', () => {
  // The engine's writes, plus what the notification executor's send reads in
  // its transaction: no erasure lock contention, no erasure receipts.
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    aiWorkflowExecution: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    aiWorkflowRunningStep: {
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
    },
    dataErasureReceipt: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    prisma: {
      ...prisma,
      $transaction: vi.fn((run: (client: unknown) => Promise<unknown>) => run(prisma)),
    },
  };
});

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
  },
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({ emitHookEvent: vi.fn() }));
vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/orchestration/engine/lease', () => ({
  claimLease: vi.fn(),
  generateLeaseToken: vi.fn().mockReturnValue('lease-token-test'),
  leaseExpiry: vi.fn().mockReturnValue(new Date()),
  startHeartbeat: vi.fn().mockReturnValue(vi.fn()),
  recordReleaseEvent: vi.fn().mockResolvedValue(undefined),
}));

// The email provider, and what the notification executor reads around it.
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/locale', () => ({
  emailLocaleForOrg: vi.fn(async () => ({ locale: 'en', timeZone: 'UTC' })),
}));
vi.mock('@/emails/workflow-notification', () => ({ WorkflowNotification: vi.fn(() => null) }));
vi.mock('@/lib/orchestration/engine/dispatch-cache', () => ({
  buildIdempotencyKey: vi.fn(
    ({ executionId, stepId }: { executionId: string; stepId: string }) => `${executionId}:${stepId}`
  ),
  lookupDispatch: vi.fn().mockResolvedValue(null),
  recordDispatch: vi.fn().mockResolvedValue(true),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  getExecutor,
  registerStepType,
  type StepExecutor,
} from '@/lib/orchestration/engine/executor-registry';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { isRecord } from '@/lib/utils';
import { claimLease } from '@/lib/orchestration/engine/lease';
import { prisma } from '@/lib/db/client';
import { sendEmail } from '@/lib/email/send';
import { PROVIDER_MODEL_AUDIT_TEMPLATE } from '@/prisma/seeds/data/templates/provider-model-audit';
import type {
  ExecutionEvent,
  ExecutionTraceEntry,
  WorkflowDefinition,
  WorkflowStep,
} from '@/types/orchestration';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function run(definition: WorkflowDefinition): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  const engine = new OrchestrationEngine();
  for await (const e of engine.execute(
    { id: 'wf_test', definition },
    {},
    { userId: 'user_test' }
  )) {
    events.push(e);
  }
  return events;
}

/** Resume a run whose trace records `ran`, from the row `extra` describes. */
async function resume(
  definition: WorkflowDefinition,
  ran: WorkflowStep[],
  extra: { status: string; currentStep: string; walkState?: unknown }
): Promise<ExecutionEvent[]> {
  const now = new Date().toISOString();
  vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
    id: 'exec_test',
    workflowId: 'wf_test',
    userId: 'user_test',
    inputData: {},
    executionTrace: ran.map((s) => ({
      stepId: s.id,
      stepType: s.type,
      label: s.name,
      status: 'completed',
      output: `out:${s.id}`,
      tokensUsed: 0,
      costUsd: 0,
      startedAt: now,
      completedAt: now,
      durationMs: 1,
    })),
    totalTokensUsed: 0,
    totalCostUsd: 0,
    budgetLimitUsd: null,
    startedAt: new Date(),
    completedAt: null,
    outputData: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    walkState: null,
    ...extra,
  } as never);
  const events: ExecutionEvent[] = [];
  const engine = new OrchestrationEngine();
  for await (const e of engine.execute(
    { id: 'wf_test', definition },
    {},
    { userId: 'user_test', resumeFromExecutionId: 'exec_test' }
  )) {
    events.push(e);
  }
  return events;
}

const started = (events: ExecutionEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'step_started' ? [e.stepId] : []));

const terminal = (events: ExecutionEvent[]) => {
  const last = events.at(-1);
  if (last?.type !== 'workflow_failed' && last?.type !== 'workflow_completed') {
    throw new Error(`run did not end: last event ${last?.type}`);
  }
  return last;
};

/** The status and trace the run was finalised with. */
function finalised(): { status: unknown; errorMessage: unknown; trace: ExecutionTraceEntry[] } {
  const calls = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls;
  const final = calls
    .map((c) => c[0]?.data as Record<string, unknown> | undefined)
    .findLast((d) => d !== undefined && (d.status === 'completed' || d.status === 'failed'));
  if (!final) throw new Error('run was never finalised');
  return {
    status: final.status,
    errorMessage: final.errorMessage,
    trace: final.executionTrace as ExecutionTraceEntry[],
  };
}

/** A guard stub: picks its first edge for the verdict, as the real guard does. */
function guardStub(verdicts: Record<string, () => 'pass' | 'fail'>): StepExecutor {
  return async (step: WorkflowStep) => {
    const verdict = verdicts[step.id]?.() ?? 'pass';
    const edge = step.nextSteps.find((e) => e.condition === verdict);
    return {
      output: { passed: verdict === 'pass', reason: `${step.id} said ${verdict}` },
      tokensUsed: 0,
      costUsd: 0,
      nextStepIds: edge ? [edge.targetStepId] : [],
    };
  };
}

const ok: StepExecutor = async (step) => ({ output: `out:${step.id}`, tokensUsed: 0, costUsd: 0 });

/** A route stub that takes the edge labelled `label`. */
function routeTo(label: string): StepExecutor {
  return async (step) => ({
    output: label,
    tokensUsed: 0,
    costUsd: 0,
    nextStepIds: step.nextSteps.filter((e) => e.condition === label).map((e) => e.targetStepId),
  });
}

const step = (
  id: string,
  type: WorkflowStep['type'],
  nextSteps: WorkflowStep['nextSteps'] = [],
  config: Record<string, unknown> = {}
): WorkflowStep => ({ id, name: id, type, config, nextSteps });

/**
 * Two guards in a row, each with a bounded retry back to `produce` and a
 * sibling `fail` edge to one shared failure step — the audit's shape.
 */
function twoGuardsOneFailureStep(): WorkflowDefinition {
  return {
    entryStepId: 'produce',
    errorStrategy: 'fail',
    steps: [
      step('produce', 'llm_call', [{ targetStepId: 'check_shape' }]),
      step('check_shape', 'guard', [
        { targetStepId: 'check_sense', condition: 'pass' },
        { targetStepId: 'produce', condition: 'fail', maxRetries: 2 },
        { targetStepId: 'report_failure', condition: 'fail' },
      ]),
      step('check_sense', 'guard', [
        { targetStepId: 'apply', condition: 'pass' },
        { targetStepId: 'produce', condition: 'fail', maxRetries: 2 },
        { targetStepId: 'report_failure', condition: 'fail' },
      ]),
      step('apply', 'llm_call'),
      step('report_failure', 'send_notification'),
    ],
  };
}

/** A stand-in failure step that ends the run failed with its reason. */
const reportsFailure: StepExecutor = async (step) => ({
  output: { sent: true },
  tokensUsed: 0,
  costUsd: 0,
  failWorkflow: `${step.id}: validation failed after retries`,
});

let realNotification: StepExecutor;

beforeAll(() => {
  // The engine imports the executors barrel, which registers the real ones.
  realNotification = getExecutor('send_notification');
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryForTests();
  vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
    id: 'exec_test',
    status: 'running',
    startedAt: new Date('2026-11-20T09:00:00Z'),
    createdAt: new Date(0),
  } as never);
  vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
    id: 'exec_test',
    workflowId: 'wf_test',
    userId: 'user_test',
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
  vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 });
  vi.mocked(claimLease).mockResolvedValue('lease-token-test');
  vi.mocked(sendEmail).mockResolvedValue({ status: 'sent', success: true });
});

afterEach(() => {
  __resetRegistryForTests();
});

// ─── t-1077: a step with edges from steps that may not all run ──────────────

describe('a failure step with fail edges from two guards (t-1077)', () => {
  beforeEach(() => {
    registerStepType('llm_call', ok);
    registerStepType('send_notification', reportsFailure);
  });

  it('runs when the first guard gives up after its retries, and ends with its reason', async () => {
    registerStepType('guard', guardStub({ check_shape: () => 'fail' }));

    const events = await run(twoGuardsOneFailureStep());

    // Three attempts at the first guard (one, plus two retries), then the
    // failure step; the second guard and `apply` never run.
    expect(started(events)).toEqual([
      'produce',
      'check_shape',
      'produce',
      'check_shape',
      'produce',
      'check_shape',
      'report_failure',
    ]);
    const end = terminal(events);
    expect(end.type).toBe('workflow_failed');
    expect(end.type === 'workflow_failed' && end.error).toBe(
      'report_failure: validation failed after retries'
    );
    expect(finalised()).toMatchObject({
      status: 'failed',
      errorMessage: 'report_failure: validation failed after retries',
    });
  });

  it('runs when the second guard gives up after its retries', async () => {
    registerStepType('guard', guardStub({ check_shape: () => 'pass', check_sense: () => 'fail' }));

    const events = await run(twoGuardsOneFailureStep());

    expect(started(events).filter((id) => id === 'check_sense')).toHaveLength(3);
    expect(started(events).at(-1)).toBe('report_failure');
    expect(started(events)).not.toContain('apply');
    expect(terminal(events)).toMatchObject({
      type: 'workflow_failed',
      error: 'report_failure: validation failed after retries',
    });
  });

  it('runs the failure step once when the second guard gives up after the first one retried', async () => {
    // The first guard fails once, then passes; the second always fails. The
    // retry re-opens what the first attempt left untaken downstream.
    const shape = ['fail', 'pass', 'pass', 'pass'] as const;
    let shapeCalls = 0;
    registerStepType(
      'guard',
      guardStub({ check_shape: () => shape[shapeCalls++], check_sense: () => 'fail' })
    );

    const events = await run(twoGuardsOneFailureStep());

    expect(started(events).filter((id) => id === 'report_failure')).toHaveLength(1);
    expect(started(events)).not.toContain('apply');
    expect(terminal(events).type).toBe('workflow_failed');
  });

  it('never runs the failure step when a retry passes both guards', async () => {
    // Failing once marks nothing untaken for good: the retry clears it, so
    // `apply` runs and the failure step stays unreached.
    const shape = ['fail', 'pass'] as const;
    let shapeCalls = 0;
    registerStepType('guard', guardStub({ check_shape: () => shape[shapeCalls++] }));

    const events = await run(twoGuardsOneFailureStep());

    expect(started(events)).toEqual([
      'produce',
      'check_shape',
      'produce',
      'check_shape',
      'check_sense',
      'apply',
    ]);
    expect(terminal(events).type).toBe('workflow_completed');
  });
});

describe('joins still wait for every branch that was taken (t-1077)', () => {
  beforeEach(() => {
    registerStepType('llm_call', ok);
  });

  it('a join after a parallel step waits for its longest branch', async () => {
    // parallel → (a1 → a2) and b → join. After the batch [a1, b] the join
    // still waits for a2: every branch of a parallel step is taken.
    registerStepType('parallel', ok);
    const events = await run({
      entryStepId: 'fan',
      errorStrategy: 'fail',
      steps: [
        step('fan', 'parallel', [{ targetStepId: 'a1' }, { targetStepId: 'b' }], {
          branches: ['a1', 'b'],
        }),
        step('a1', 'llm_call', [{ targetStepId: 'a2' }]),
        step('a2', 'llm_call', [{ targetStepId: 'join' }]),
        step('b', 'llm_call', [{ targetStepId: 'join' }]),
        step('join', 'llm_call'),
      ],
    });

    const order = started(events);
    expect(order.filter((id) => id === 'join')).toHaveLength(1);
    expect(order.indexOf('join')).toBeGreaterThan(order.indexOf('a2'));
    expect(order.indexOf('join')).toBeGreaterThan(order.indexOf('b'));
    expect(terminal(events).type).toBe('workflow_completed');
  });

  it('a join after a route waits for the taken branch, and not for the untaken one', async () => {
    // route → (x1 → x2) | y → join. Only x is taken. The join used to wait
    // on y forever; now it runs once x2 has.
    registerStepType('route', routeTo('x'));
    const events = await run({
      entryStepId: 'pick',
      errorStrategy: 'fail',
      steps: [
        step('pick', 'route', [
          { targetStepId: 'x1', condition: 'x' },
          { targetStepId: 'y', condition: 'y' },
        ]),
        step('x1', 'llm_call', [{ targetStepId: 'x2' }]),
        step('x2', 'llm_call', [{ targetStepId: 'join' }]),
        step('y', 'llm_call', [{ targetStepId: 'join' }]),
        step('join', 'llm_call'),
      ],
    });

    expect(started(events)).toEqual(['pick', 'x1', 'x2', 'join']);
    expect(terminal(events).type).toBe('workflow_completed');
  });

  it('a join waits for a branch whose own guard has not run yet', async () => {
    // parallel → a, (b → guard) ; a → join, guard --pass--> join. The join
    // must wait for the guard, which is reached, not treat it as untaken.
    registerStepType('parallel', ok);
    registerStepType('guard', guardStub({ gate: () => 'pass' }));
    const events = await run({
      entryStepId: 'fan',
      errorStrategy: 'fail',
      steps: [
        step('fan', 'parallel', [{ targetStepId: 'a' }, { targetStepId: 'b' }], {
          branches: ['a', 'b'],
        }),
        step('a', 'llm_call', [{ targetStepId: 'join' }]),
        step('b', 'llm_call', [{ targetStepId: 'gate' }]),
        step('gate', 'guard', [
          { targetStepId: 'join', condition: 'pass' },
          { targetStepId: 'stop', condition: 'fail' },
        ]),
        step('join', 'llm_call'),
        step('stop', 'llm_call'),
      ],
    });

    const order = started(events);
    expect(order.indexOf('join')).toBeGreaterThan(order.indexOf('gate'));
    expect(order).not.toContain('stop');
    expect(terminal(events).type).toBe('workflow_completed');
  });
});

describe('a join behind a branch not taken, across a resume or a fallback (t-1077)', () => {
  beforeEach(() => {
    registerStepType('llm_call', ok);
    registerStepType('route', routeTo('a'));
  });

  /** route → a → hold → join | b → join. Only a is taken. */
  const routeThenJoin = (): WorkflowDefinition => ({
    entryStepId: 'pick',
    errorStrategy: 'fail',
    steps: [
      step('pick', 'route', [
        { targetStepId: 'a', condition: 'a' },
        { targetStepId: 'b', condition: 'b' },
      ]),
      step('a', 'llm_call', [{ targetStepId: 'hold' }]),
      step('hold', 'llm_call', [{ targetStepId: 'join' }]),
      step('b', 'llm_call', [{ targetStepId: 'join' }]),
      step('join', 'llm_call'),
    ],
  });

  /**
   * The position the paused step's iteration saved as it began. Approving the
   * pause sets the row PENDING and keeps it.
   */
  const pausedAt = (inFlight: string[], visited: string[], untaken?: string[]) => ({
    v: 1,
    inFlight,
    batch: inFlight.length > 1,
    done: {},
    pending: [],
    visited,
    ...(untaken ? { untaken } : {}),
    retryCounts: {},
    stepCount: visited.length,
    budgetWarned: false,
  });

  it('runs the join after an approval resume, from what was untaken at the pause', async () => {
    const definition = routeThenJoin();
    const [pick, a, hold] = definition.steps;

    const events = await resume(definition, [pick, a, hold], {
      status: 'pending',
      currentStep: 'hold',
      walkState: pausedAt(['hold'], ['pick', 'a', 'hold'], ['b']),
    });

    expect(started(events)).toEqual(['join']);
    expect(terminal(events).type).toBe('workflow_completed');
  });

  it("ignores a saved position that is not the paused step's own", async () => {
    const definition = routeThenJoin();
    const [pick, a, hold] = definition.steps;

    const events = await resume(definition, [pick, a, hold], {
      status: 'pending',
      currentStep: 'hold',
      walkState: pausedAt(['a'], ['pick', 'a'], ['b']),
    });

    // Nothing is known untaken, so the join waits on b as it did before.
    expect(started(events)).toEqual([]);
    expect(terminal(events)).toMatchObject({ type: 'workflow_failed' });
    expect(String(finalised().errorMessage)).toContain('deadlocked');
  });

  it('never treats a step a paused batch sibling chose as untaken', async () => {
    // fan → a → hold → join, b → c → d → join. hold and c ran as a batch and
    // hold paused after c had chosen d. The trace alone would make d look
    // untaken and run the join without it; the run must not complete
    // having skipped d.
    registerStepType('parallel', ok);
    const definition: WorkflowDefinition = {
      entryStepId: 'fan',
      errorStrategy: 'fail',
      steps: [
        step('fan', 'parallel', [{ targetStepId: 'a' }, { targetStepId: 'b' }], {
          branches: ['a', 'b'],
        }),
        step('a', 'llm_call', [{ targetStepId: 'hold' }]),
        step('b', 'llm_call', [{ targetStepId: 'c' }]),
        step('hold', 'llm_call', [{ targetStepId: 'join' }]),
        step('c', 'llm_call', [{ targetStepId: 'd' }]),
        step('d', 'llm_call', [{ targetStepId: 'join' }]),
        step('join', 'llm_call'),
      ],
    };
    const ran = definition.steps.filter((s) => ['fan', 'a', 'b', 'hold', 'c'].includes(s.id));

    const events = await resume(definition, ran, {
      status: 'pending',
      currentStep: 'hold',
      walkState: pausedAt(['hold', 'c'], ['fan', 'a', 'b', 'hold', 'c'], []),
    });

    expect(started(events)).not.toContain('join');
    expect(terminal(events).type).toBe('workflow_failed');
  });

  it('runs the join after a crash-resume from a position saved before `untaken` existed', async () => {
    const definition = routeThenJoin();
    const [pick, a] = definition.steps;

    const events = await resume(definition, [pick, a], {
      status: 'running',
      currentStep: 'hold',
      walkState: {
        v: 1,
        inFlight: ['hold'],
        batch: false,
        done: {},
        pending: [],
        visited: ['pick', 'a', 'hold'],
        retryCounts: {},
        stepCount: 3,
        budgetWarned: false,
      },
    });

    expect(started(events)).toEqual(['hold', 'join']);
    expect(terminal(events).type).toBe('workflow_completed');
  });

  /**
   * fan → (pick → keep | spare), (s1 → late); keep → join, spare → join.
   * `late` falls back to `spare`, so `spare` is not untaken while `late` has
   * yet to run, even though `pick` chose `keep`.
   */
  const fallbackIntoUntaken = (): WorkflowDefinition => ({
    entryStepId: 'fan',
    errorStrategy: 'fail',
    steps: [
      step('fan', 'parallel', [{ targetStepId: 'pick' }, { targetStepId: 's1' }], {
        branches: ['pick', 's1'],
      }),
      step('pick', 'route', [
        { targetStepId: 'keep', condition: 'a' },
        { targetStepId: 'spare', condition: 'b' },
      ]),
      step('s1', 'llm_call', [{ targetStepId: 'late' }]),
      step('late', 'llm_call', [], { errorStrategy: 'fallback', fallbackStepId: 'spare' }),
      step('keep', 'llm_call', [{ targetStepId: 'join' }]),
      step('spare', 'llm_call', [{ targetStepId: 'join' }]),
      step('join', 'llm_call'),
    ],
  });

  it('waits for a step another step can still fall back to', async () => {
    registerStepType('parallel', ok);
    registerStepType('llm_call', async (s) => {
      if (s.id === 'late') throw new ExecutorError(s.id, 'boom', 'late failed');
      return { output: `out:${s.id}`, tokensUsed: 0, costUsd: 0 };
    });

    const events = await run(fallbackIntoUntaken());

    const order = started(events);
    expect(order).toContain('spare');
    expect(order.indexOf('join')).toBeGreaterThan(order.indexOf('spare'));
    expect(order.filter((id) => id === 'join')).toHaveLength(1);
    expect(terminal(events).type).toBe('workflow_completed');
  });

  it('reopens what a retry left untaken through a fallback step', async () => {
    // a → b → check; b falls back to spare; check retries a once. Attempt 1:
    // b works, so spare is untaken. The retry reopens b, so spare is open
    // again for attempt 2, where b may fall back to it.
    let checkCalls = 0;
    registerStepType('guard', guardStub({ check: () => (++checkCalls === 1 ? 'fail' : 'pass') }));

    const events = await run({
      entryStepId: 'a',
      errorStrategy: 'fail',
      steps: [
        step('a', 'llm_call', [{ targetStepId: 'b' }]),
        step('b', 'llm_call', [{ targetStepId: 'check' }], {
          errorStrategy: 'fallback',
          fallbackStepId: 'spare',
        }),
        step('check', 'guard', [
          { targetStepId: 'a', condition: 'fail', maxRetries: 1 },
          { targetStepId: 'done', condition: 'pass' },
        ]),
        step('spare', 'llm_call'),
        step('done', 'llm_call'),
      ],
    });

    expect(terminal(events).type).toBe('workflow_completed');
    // The walk positions saved as each iteration began, in order.
    const positions = vi
      .mocked(prisma.aiWorkflowExecution.updateMany)
      .mock.calls.map((c) => (c[0]?.data as Record<string, unknown> | undefined)?.walkState)
      .filter((w): w is { inFlight: string[]; untaken?: string[] } => isRecord(w));
    // Each iteration's position is written as it begins and again by its
    // checkpoint: the same object, so dedupe by identity.
    const starts = [
      ...new Set(positions.filter((w) => w.inFlight.length === 1 && w.inFlight[0] === 'a')),
    ];
    expect(starts).toHaveLength(2);
    // Attempt 1's check saw spare untaken; attempt 2 starts with it open.
    expect(positions.some((w) => w.untaken?.includes('spare'))).toBe(true);
    expect(starts[1].untaken).not.toContain('spare');
  });

  it('runs a join again after a retry that cleared it through an untaken branch', async () => {
    // s → x → join, s → pick; pick → a | b, b → join; a → check, which
    // retries pick once. Attempt 1: pick takes a, b is untaken, and the join
    // runs on x. The retry clears b and, through it, the join, though x
    // (which reached it) does not run again. The join must run again in
    // attempt 2 rather than be marked untaken.
    let checkCalls = 0;
    registerStepType('guard', guardStub({ check: () => (++checkCalls === 1 ? 'fail' : 'pass') }));

    const events = await run({
      entryStepId: 's',
      errorStrategy: 'fail',
      steps: [
        step('s', 'llm_call', [{ targetStepId: 'x' }, { targetStepId: 'pick' }]),
        step('x', 'llm_call', [{ targetStepId: 'join' }]),
        step('pick', 'route', [
          { targetStepId: 'a', condition: 'a' },
          { targetStepId: 'b', condition: 'b' },
        ]),
        step('a', 'llm_call', [{ targetStepId: 'check' }]),
        step('b', 'llm_call', [{ targetStepId: 'join' }]),
        step('check', 'guard', [
          { targetStepId: 'pick', condition: 'fail', maxRetries: 1 },
          { targetStepId: 'done', condition: 'pass' },
        ]),
        step('join', 'llm_call'),
        step('done', 'llm_call'),
      ],
    });

    const order = started(events);
    expect(order.filter((id) => id === 'pick')).toHaveLength(2);
    expect(order.filter((id) => id === 'join')).toHaveLength(2);
    expect(order).not.toContain('b');
    expect(terminal(events).type).toBe('workflow_completed');
  });

  it('runs the join once the step that could fall back has run without falling back', async () => {
    registerStepType('parallel', ok);

    const events = await run(fallbackIntoUntaken());

    const order = started(events);
    expect(order).not.toContain('spare');
    expect(order.at(-1)).toBe('join');
    expect(terminal(events).type).toBe('workflow_completed');
  });
});

// ─── t-1078: a failure step whose notice can't be sent ──────────────────────

describe('a step that ends the run failed, whether or not its work succeeds (t-1078)', () => {
  const failureStep = (): WorkflowStep => step('notify', 'llm_call', [], { errorStrategy: 'skip' });

  it('ends the run failed with the step reason when the step succeeds', async () => {
    registerStepType('llm_call', async () => ({
      output: { sent: true },
      tokensUsed: 0,
      costUsd: 0,
      failWorkflow: 'halted at a validation gate',
    }));

    const events = await run({
      entryStepId: 'notify',
      errorStrategy: 'fail',
      steps: [failureStep()],
    });

    expect(terminal(events)).toMatchObject({
      type: 'workflow_failed',
      error: 'halted at a validation gate',
    });
    const { status, trace } = finalised();
    expect(status).toBe('failed');
    expect(trace.find((e) => e.stepId === 'notify')?.status).toBe('completed');
  });

  it('ends the run failed with the step reason when its error is skipped, keeping the error in the trace', async () => {
    registerStepType('llm_call', async (s) => {
      throw new ExecutorError(
        s.id,
        'EMAIL_SEND_FAILED',
        'Email send failed: refused',
        undefined,
        true,
        0,
        0,
        'halted at a validation gate'
      );
    });

    const events = await run({
      entryStepId: 'notify',
      errorStrategy: 'fail',
      steps: [failureStep()],
    });

    expect(terminal(events)).toMatchObject({
      type: 'workflow_failed',
      error: 'halted at a validation gate',
      failedStepId: 'notify',
    });
    const { status, errorMessage, trace } = finalised();
    expect(status).toBe('failed');
    expect(errorMessage).toBe('halted at a validation gate');
    const entry = trace.find((e) => e.stepId === 'notify');
    expect(entry?.status).toBe('skipped');
    expect(entry?.error).toContain('Email send failed: refused');
  });

  it('still completes the run when a skipped error carries no reason', async () => {
    registerStepType('llm_call', async (s) => {
      throw new ExecutorError(s.id, 'EMAIL_SEND_FAILED', 'Email send failed: refused');
    });

    const events = await run({
      entryStepId: 'notify',
      errorStrategy: 'fail',
      steps: [failureStep()],
    });

    expect(terminal(events).type).toBe('workflow_completed');
  });

  it('ends the run failed when the skipped step is a parallel branch', async () => {
    registerStepType('parallel', ok);
    registerStepType('llm_call', async (s) => {
      if (s.id === 'notify') {
        throw new ExecutorError(
          s.id,
          'EMAIL_SEND_FAILED',
          'refused',
          undefined,
          true,
          0,
          0,
          'halted'
        );
      }
      return { output: 'ok', tokensUsed: 0, costUsd: 0 };
    });

    const events = await run({
      entryStepId: 'fan',
      errorStrategy: 'fail',
      steps: [
        step('fan', 'parallel', [{ targetStepId: 'notify' }, { targetStepId: 'other' }], {
          branches: ['notify', 'other'],
        }),
        step('notify', 'llm_call', [], { errorStrategy: 'skip' }),
        step('other', 'llm_call'),
      ],
    });

    // A batch reports its branches' events together, so the failure is not
    // necessarily the last one.
    expect(events.find((e) => e.type === 'workflow_failed')).toMatchObject({ error: 'halted' });
    expect(events.map((e) => e.type)).not.toContain('workflow_completed');
    expect(finalised()).toMatchObject({ status: 'failed', errorMessage: 'halted' });
  });
});

describe('a failed notification that is not the send failing (t-1078)', () => {
  const notify = (config: Record<string, unknown>): WorkflowDefinition => ({
    entryStepId: 'notify',
    errorStrategy: 'fail',
    steps: [
      step('notify', 'send_notification', [{ targetStepId: 'after' }], {
        terminalStatus: 'failed',
        ...config,
      }),
      step('after', 'llm_call'),
    ],
  });

  beforeEach(() => {
    registerStepType('llm_call', ok);
  });

  it('ends the run failed when the step times out and is skipped', async () => {
    registerStepType('send_notification', () => new Promise(() => {}));

    const events = await run(notify({ errorStrategy: 'skip', timeoutMs: 20 }));

    expect(terminal(events).type).toBe('workflow_failed');
    expect(started(events)).not.toContain('after');
    const { status, trace } = finalised();
    expect(status).toBe('failed');
    expect(trace.find((e) => e.stepId === 'notify')?.status).toBe('skipped');
  });

  it('ends the run failed when the step falls back with no fallback step', async () => {
    registerStepType('send_notification', async (s) => {
      throw new ExecutorError(
        s.id,
        'EMAIL_SEND_FAILED',
        'refused',
        undefined,
        true,
        0,
        0,
        'halted'
      );
    });

    const events = await run(notify({ errorStrategy: 'fallback' }));

    expect(terminal(events)).toMatchObject({ type: 'workflow_failed', error: 'halted' });
    expect(started(events)).not.toContain('after');
    expect(finalised()).toMatchObject({ status: 'failed', errorMessage: 'halted' });
  });

  it('hands on to its fallback step when it has one, and the run carries on', async () => {
    registerStepType('send_notification', async (s) => {
      throw new ExecutorError(
        s.id,
        'EMAIL_SEND_FAILED',
        'refused',
        undefined,
        true,
        0,
        0,
        'halted'
      );
    });

    const events = await run({
      entryStepId: 'notify',
      errorStrategy: 'fail',
      steps: [
        step('notify', 'send_notification', [], {
          terminalStatus: 'failed',
          errorStrategy: 'fallback',
          fallbackStepId: 'backup',
        }),
        step('backup', 'llm_call'),
      ],
    });

    expect(started(events)).toEqual(['notify', 'backup']);
    expect(terminal(events).type).toBe('workflow_completed');
  });

  it('still completes the run when the step is not marked failed', async () => {
    registerStepType('send_notification', () => new Promise(() => {}));

    const events = await run({
      entryStepId: 'notify',
      errorStrategy: 'fail',
      steps: [step('notify', 'send_notification', [], { errorStrategy: 'skip', timeoutMs: 20 })],
    });

    expect(terminal(events).type).toBe('workflow_completed');
  });
});

// ─── Both, on the provider model audit template itself ──────────────────────

describe('the provider model audit, when a validation guard gives up', () => {
  const definition = PROVIDER_MODEL_AUDIT_TEMPLATE.workflowDefinition;
  const HALTED = 'The Provider Model Audit halted at a validation gate';

  beforeEach(() => {
    for (const type of [
      'llm_call',
      'agent_call',
      'external_call',
      'tool_call',
      'reflect',
      'evaluate',
      'report',
      'parallel',
    ] as const) {
      registerStepType(type, ok);
    }
    registerStepType('route', routeTo('chat'));
    registerStepType('send_notification', realNotification);
  });

  type Verdicts = Record<string, () => 'pass' | 'fail'>;
  const giveUps: Array<[string, Verdicts]> = [
    ['the schema guard', { validate_proposals: () => 'fail' }],
    ['the rationale guard', { validate_proposals: () => 'pass', validate_rationale: () => 'fail' }],
  ];

  it.each(giveUps)(
    '%s: runs report_validation_failure and ends failed, not deadlocked',
    async (_, verdicts) => {
      registerStepType('guard', guardStub(verdicts));

      const events = await run(definition);

      expect(started(events).at(-1)).toBe('report_validation_failure');
      expect(started(events)).not.toContain('refine_findings');
      const end = terminal(events);
      expect(end.type).toBe('workflow_failed');
      expect(end.type === 'workflow_failed' && end.error).toContain(HALTED);
      expect(end.type === 'workflow_failed' && end.error).not.toContain('deadlocked');
      expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
      expect(finalised().status).toBe('failed');
    }
  );

  it('ends failed, not completed, when the admin email is refused', async () => {
    registerStepType('guard', guardStub({ validate_proposals: () => 'fail' }));
    vi.mocked(sendEmail).mockResolvedValue({
      status: 'failed',
      success: false,
      error: 'Invalid `to` field: testing email address',
    });

    const events = await run(definition);

    const end = terminal(events);
    expect(end.type).toBe('workflow_failed');
    expect(end.type === 'workflow_failed' && end.error).toContain(HALTED);
    const { status, errorMessage, trace } = finalised();
    expect(status).toBe('failed');
    expect(String(errorMessage)).toContain(HALTED);
    const entry = trace.find((e) => e.stepId === 'report_validation_failure');
    expect(entry?.status).toBe('skipped');
    expect(entry?.error).toContain('Invalid `to` field');
  });
});
