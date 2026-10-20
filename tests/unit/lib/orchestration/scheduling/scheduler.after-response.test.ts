/**
 * Every engine drain the scheduler starts is kept alive past the response
 * that started it (t-846).
 *
 * On a serverless host, work still running after the response can be frozen,
 * so a bare `void drainEngine(...)` could stop a run part-way. Each drain is
 * handed to Next's `after()` through `keepRunningAfterResponse`. These tests
 * mock `after()` to record what it was handed, then hold the engine open and
 * check that the recorded promise is the drain itself: still pending while
 * the engine runs, settled once it finishes. A promise that settled early
 * would let the host freeze the run anyway.
 *
 * The path with no request scope (the dev ticker) is the rest of
 * `scheduler.test.ts`, where the real `after()` throws and every drain still
 * runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockAfter = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mockAfter,
}));

vi.mock('@/lib/db/client', () => {
  const prisma = {
    $transaction: vi.fn(),
    aiWorkflowSchedule: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    aiWorkflowExecution: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    aiWorkflowExecutionLeaseEvent: {
      create: vi.fn().mockResolvedValue({ id: 'evt-test' }),
    },
    aiOrchestrationSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) =>
    callback(prisma)
  );
  return { prisma };
});

// Nobody is erased; the erasure checks are proved in their own tests.
vi.mock('@/lib/privacy/erased-subjects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/privacy/erased-subjects')>()),
  findErasedSubjects: vi.fn(async () => ({ addresses: [] as string[], userIds: [] as string[] })),
  tryLockSubjects: vi.fn(async () => true),
  boundLockWaits: vi.fn(async () => undefined),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockExecute = vi.fn();
vi.mock('@/lib/orchestration/engine/orchestration-engine', () => ({
  OrchestrationEngine: class {
    execute = mockExecute;
  },
}));

vi.mock('@/lib/validations/orchestration', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/validations/orchestration')>()),
  workflowDefinitionSchema: {
    parse: vi.fn((value: unknown) => value),
    safeParse: vi.fn((value: unknown) => ({ success: true, data: value })),
  },
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({ emitHookEvent: vi.fn() }));
vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/orchestration/webhooks/payload-context', () => ({
  resolveUserDisplayName: vi.fn().mockResolvedValue(undefined),
  resolveWorkflowDisplay: vi.fn().mockResolvedValue({}),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  drainEngine,
  processDueSchedules,
  processOrphanedExecutions,
  processPendingExecutions,
  resumeApprovedExecution,
} from '@/lib/orchestration/scheduling/scheduler';
import { prisma } from '@/lib/db/client';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEFINITION = {
  steps: [{ id: 'step1', type: 'llm_call', config: {} }],
  entryStepId: 'step1',
  errorStrategy: 'fail',
};

const WORKFLOW = {
  id: 'wf_1',
  slug: 'test-workflow',
  isActive: true,
  maxCostPerExecutionUsd: null,
  publishedVersion: { id: 'wfv_1', snapshot: DEFINITION },
};

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec_1',
    workflowId: 'wf_1',
    versionId: 'wfv_1',
    status: 'pending',
    inputData: { topic: 'test' },
    executionTrace: [],
    userId: null,
    recoveryAttempts: 0,
    leaseToken: 'lease_abc',
    leaseExpiresAt: new Date('2026-01-01T00:00:00Z'),
    lastHeartbeatAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    workflow: WORKFLOW,
    version: { id: 'wfv_1', snapshot: DEFINITION },
    ...overrides,
  };
}

/** An engine run that stays open until the test releases it. */
function holdEngineOpen(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockExecute.mockReturnValue(
    (async function* () {
      await gate;
      yield { type: 'workflow_completed' };
    })()
  );
  return { release };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Assert that the one promise handed to `after()` is the engine drain: pending
 * while the engine is held open, settled once it is released.
 */
async function expectDrainKeptAlive(release: () => void): Promise<void> {
  expect(mockExecute).toHaveBeenCalledTimes(1);
  // `after()` may also have been handed an enclosing task (the resume); the
  // drain is the last one registered.
  const handed = mockAfter.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
  expect(handed).toBeInstanceOf(Promise);

  let settled = false;
  void handed!.then(() => {
    settled = true;
  });
  await flush();
  expect(settled).toBe(false);

  release();
  await handed;
  expect(settled).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAfter.mockImplementation(() => undefined);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('scheduler drains are kept alive past the response (t-846)', () => {
  it('a fired schedule', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([
      {
        id: 'sched_1',
        workflowId: 'wf_1',
        name: 'Daily run',
        cronExpression: '0 9 * * *',
        inputTemplate: { topic: 'test' },
        isEnabled: true,
        lastRunAt: null,
        nextRunAt: new Date('2026-01-01T09:00:00Z'),
        createdBy: 'user_1',
        workflow: WORKFLOW,
      },
    ] as never);
    vi.mocked(prisma.aiWorkflowSchedule.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'exec_1',
      inputData: { topic: 'test' },
    } as never);
    const { release } = holdEngineOpen();

    const result = await processDueSchedules();

    expect(result.succeeded).toBe(1);
    await expectDrainKeptAlive(release);
  });

  it('a recovered pending execution', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([makeExecution()] as never);
    const { release } = holdEngineOpen();

    const result = await processPendingExecutions();

    expect(result.recovered).toBe(1);
    await expectDrainKeptAlive(release);
  });

  it('a re-driven orphan', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([
      makeExecution({ id: 'exec_orphan', status: 'running' }),
    ] as never);
    const { release } = holdEngineOpen();

    const result = await processOrphanedExecutions();

    expect(result.recovered).toBe(1);
    await expectDrainKeptAlive(release);
  });

  it('a resumed approval, which settles only when its run does', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    const { release } = holdEngineOpen();

    // Not awaited: it awaits the drain, so a caller holding this promise holds
    // the whole resume (the routes hand it to `keepRunningAfterResponse`).
    let resumed = false;
    const resume = resumeApprovedExecution('exec_1').then(() => {
      resumed = true;
    });
    await flush();
    expect(resumed).toBe(false);

    await expectDrainKeptAlive(release);
    await resume;
    expect(resumed).toBe(true);
  });

  it('a crashed run’s execution_crashed webhook outlives the drain (t-903)', async () => {
    mockExecute.mockReturnValue(
      (async function* () {
        await Promise.resolve();
        throw new Error('engine blew up');
        yield { type: 'never' };
      })()
    );
    vi.mocked(prisma.aiWorkflowExecution.update).mockResolvedValue({} as never);
    let finishDispatch!: () => void;
    vi.mocked(dispatchWebhookEvent).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDispatch = resolve;
      })
    );

    await drainEngine('exec_1', WORKFLOW, DEFINITION as never, {}, null, 'wfv_1');

    // The drain has settled; the crash notification it started has not.
    await vi.waitFor(() => expect(dispatchWebhookEvent).toHaveBeenCalled());
    const handed = mockAfter.mock.calls.map((call) => call[0] as Promise<unknown>);
    const states = await Promise.all(
      handed.map(async (promise) => {
        let settled = false;
        void promise.then(() => (settled = true));
        await flush();
        return settled;
      })
    );
    expect(states.filter((settled) => !settled)).toHaveLength(1);

    finishDispatch();
    await Promise.all(handed);
  });

  it('a direct caller that writes `void drainEngine(...)`, as the inbound route does', async () => {
    const { release } = holdEngineOpen();

    void drainEngine('exec_1', WORKFLOW, DEFINITION as never, {}, null, 'wfv_1');

    await expectDrainKeptAlive(release);
  });
});
