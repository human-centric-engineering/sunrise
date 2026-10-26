/**
 * Tests: the in-workflow supervisor step keeps the run's verdict history
 * (t-951).
 *
 * The step publishes its report through `StepResult.contextPatch`, which the
 * engine writes at the next checkpoint or finalize. A run reviewed
 * retroactively and then retried runs that step again; its report must archive
 * the stored verdict, after the history the stored report carries, as the
 * review route does — read under the run's row lock, at write time.
 *
 * @see lib/orchestration/supervisor/verdict-history.ts — the shared rule
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const calls: string[] = [];
  const aiWorkflowExecution = {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
      if ('supervisorReport' in args.data) calls.push('write-report');
      return { count: 1 };
    }),
  };
  const client = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      // The run's row lock, or erasure's receipts query (none here).
      if (strings.join('').includes('FOR NO KEY UPDATE')) calls.push('lock');
      return [];
    }),
    $executeRaw: vi.fn(),
    aiWorkflowExecution,
    dataErasureReceipt: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
  };
  return { calls, client };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    ...db.client,
    $transaction: vi.fn((run: (tx: unknown) => Promise<unknown>) => run(db.client)),
  },
}));
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

import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  registerStepType,
} from '@/lib/orchestration/engine/executor-registry';
import { prisma } from '@/lib/db/client';
import type { WorkflowDefinition } from '@/types/orchestration';

const NEW_REPORT = {
  verdict: 'pass',
  score: 0.9,
  summary: 'the rerun',
  strengths: [],
  weaknesses: [],
  anomalies: [],
  unverifiedAreas: [],
  confidence: 'high',
  triggeredBy: 'in_workflow',
};

const OLDEST = {
  verdict: 'concerns',
  score: 0.5,
  reviewedAt: '2026-05-15T10:00:00.000Z',
  triggeredBy: 'in_workflow',
};

/** A run reviewed retroactively once, after an earlier in-workflow verdict. */
const STORED = {
  supervisorVerdict: 'fail',
  supervisorReviewedAt: new Date('2026-05-16T10:00:00.000Z'),
  supervisorReport: {
    ...NEW_REPORT,
    verdict: 'fail',
    score: 0.2,
    summary: 'the retroactive review',
    triggeredBy: 'retroactive',
    previousVerdicts: [OLDEST],
  },
};

const oneSupervisorStep: WorkflowDefinition = {
  steps: [{ id: 'audit', name: 'Audit', type: 'supervisor', config: {}, nextSteps: [] }],
  entryStepId: 'audit',
  errorStrategy: 'fail',
};

async function run(): Promise<void> {
  for await (const _event of new OrchestrationEngine().execute(
    { id: 'wf_test', definition: oneSupervisorStep },
    {},
    { userId: 'cmuser00000000000000owner' }
  )) {
    // drain
  }
}

/** The report the engine wrote with the step's patch. */
function writtenReport(): Record<string, unknown> {
  const call = vi
    .mocked(prisma.aiWorkflowExecution.updateMany)
    .mock.calls.find((c) => 'supervisorReport' in (c[0] as { data: object }).data);
  expect(call).toBeDefined();
  return (call![0] as { data: { supervisorReport: Record<string, unknown> } }).data
    .supervisorReport;
}

let storedVerdict: typeof STORED | null = null;

describe('the in-workflow supervisor replacing a stored verdict (t-951)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRegistryForTests();
    db.calls.length = 0;
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({ id: 'exec_test' } as never);
    // The engine reads the run for other reasons too (its status); only the
    // read of the stored verdict is logged.
    storedVerdict = null;
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockImplementation((async (args: {
      select: Record<string, boolean>;
    }) => {
      if (!args.select.supervisorReport) return { status: 'running' };
      db.calls.push('read-verdict');
      return storedVerdict;
    }) as never);
    registerStepType('supervisor', async () => ({
      output: NEW_REPORT,
      tokensUsed: 0,
      costUsd: 0,
      contextPatch: {
        supervisorVerdict: NEW_REPORT.verdict,
        supervisorScore: NEW_REPORT.score,
        supervisorReport: NEW_REPORT,
        supervisorReviewedAt: new Date(),
      },
    }));
  });

  afterEach(() => {
    __resetRegistryForTests();
  });

  it('keeps the stored history and archives the verdict it replaces', async () => {
    storedVerdict = STORED;

    await run();

    expect(writtenReport()).toEqual({
      ...NEW_REPORT,
      previousVerdicts: [
        OLDEST,
        {
          verdict: 'fail',
          score: 0.2,
          reviewedAt: '2026-05-16T10:00:00.000Z',
          triggeredBy: 'retroactive',
        },
      ],
    });
  });

  it('reads the stored verdict under the run’s row lock, before the write', async () => {
    storedVerdict = STORED;

    await run();

    const start = db.calls.indexOf('read-verdict');
    expect(db.calls.slice(start - 1, start + 2)).toEqual(['lock', 'read-verdict', 'write-report']);
    expect(prisma.aiWorkflowExecution.findUnique).toHaveBeenCalledWith({
      where: { id: 'exec_test' },
      select: { supervisorVerdict: true, supervisorReport: true, supervisorReviewedAt: true },
    });
  });

  it('writes the report as published when the run has no verdict yet', async () => {
    await run();

    expect(writtenReport()).toEqual(NEW_REPORT);
  });
});
