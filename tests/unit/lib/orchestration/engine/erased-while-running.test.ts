/**
 * Tests: a running workflow does not write a person erased while it runs back
 * into its run (t-843).
 *
 * The engine holds the run's input, step outputs and trace in memory and
 * writes them at every step. Each write runs in a transaction that, after the
 * write has locked the row, asks for erasure receipts since the run started
 * (`findErasedSinceRunStarted`, real here) and redacts what it holds before
 * the transaction commits. The ordering against a real erasure is proved
 * against Postgres by `npm run smoke:erasure-running`.
 *
 * @see lib/orchestration/engine/orchestration-engine.ts — `leaveOutErasedSinceStart`
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GONE_ID = 'cmuser0000000000000000gone';
const GONE = 'gone@example.com';
const KEPT = 'kept@example.com';

const db = vi.hoisted(() => {
  const calls: string[] = [];
  /** Receipts the "since the run started" query returns; empty until a test erases. */
  const receipts: Array<{ subjectUserId: string; subjectEmailHash: string | null }> = [];
  const aiWorkflowExecution = {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        // A write of the run's trace; the engine's other updates (its current
        // step, the lease) carry none.
        if ('executionTrace' in args.data) {
          calls.push('leaseToken' in args.where ? 'write' : 'rewrite');
        }
        return { count: 1 };
      }
    ),
  };
  const client = {
    $queryRaw: vi.fn(async () => {
      calls.push('receipts');
      return receipts;
    }),
    $executeRaw: vi.fn(),
    aiWorkflowExecution,
    dataErasureReceipt: {
      findMany: vi.fn(async () =>
        receipts.map((r) => ({ ...r, metadata: { addressVerified: true } }))
      ),
    },
    user: { findMany: vi.fn(async () => []) },
  };
  return { calls, receipts, client };
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
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { prisma } from '@/lib/db/client';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import type { ExecutionEvent, WorkflowDefinition } from '@/types/orchestration';

function erase(): void {
  db.receipts.push({
    subjectUserId: GONE_ID,
    subjectEmailHash: createHash('sha256').update(GONE).digest('hex'),
  });
}

function twoSteps(): WorkflowDefinition {
  return {
    steps: [
      { id: 'a', name: 'A', type: 'llm_call', config: {}, nextSteps: [{ targetStepId: 'b' }] },
      { id: 'b', name: 'B', type: 'llm_call', config: {}, nextSteps: [] },
    ],
    entryStepId: 'a',
    errorStrategy: 'fail',
  };
}

const INPUT = { to: GONE, cc: [KEPT], approverUserIds: [GONE_ID] };

async function run(definition: WorkflowDefinition = twoSteps()): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of new OrchestrationEngine().execute(
    { id: 'wf_test', definition },
    INPUT,
    { userId: 'cmuser00000000000000owner' }
  )) {
    events.push(event);
  }
  return events;
}

type Write = { where: Record<string, unknown>; data: Record<string, unknown> };
const writes = (): Write[] =>
  vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls.map((c) => c[0] as Write);
/** What the row holds after every write: each column as last written. */
function rowAfter(): Record<string, unknown> {
  return Object.assign({}, ...writes().map((w) => w.data)) as Record<string, unknown>;
}
const namesThem = (value: unknown): boolean => {
  const text = JSON.stringify(value) ?? '';
  return text.toLowerCase().includes(GONE) || text.includes(GONE_ID);
};

describe('a run executing while a person it names is erased (t-843)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRegistryForTests();
    db.calls.length = 0;
    db.receipts.length = 0;
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({ id: 'exec_test' } as never);
  });

  afterEach(() => {
    __resetRegistryForTests();
  });

  it('leaves them out of the trace, input and step outputs it writes after the erasure', async () => {
    let seenByB: unknown;
    registerStepType('llm_call', async (step, ctx) => {
      if (step.id === 'a') {
        // The erasure commits while step a runs, after the run read its input.
        erase();
        return {
          output: { sentTo: ctx.inputData.to, note: `for ${GONE_ID}` },
          tokensUsed: 0,
          costUsd: 0,
        };
      }
      seenByB = ctx.stepOutputs.a;
      return { output: 'done', tokensUsed: 0, costUsd: 0 };
    });

    await run();

    const row = rowAfter();
    // The population is real: step a's entry is in the trace written.
    expect(JSON.stringify(row.executionTrace)).toContain('"stepId":"a"');
    expect(namesThem(row.executionTrace)).toBe(false);
    expect(namesThem(row.inputData)).toBe(false);
    expect(namesThem(row.outputData)).toBe(false);
    expect(row.inputData).toEqual({ to: '[erased]', cc: [KEPT], approverUserIds: [] });
    expect(row.outputData).toMatchObject({ a: { sentTo: '[erased]', note: 'for [erased]' } });
    // Later steps read the redacted copy too.
    expect(seenByB).toEqual({ sentTo: '[erased]', note: 'for [erased]' });
  });

  it('checks after the write has locked the row, and rewrites it in the same transaction', async () => {
    registerStepType('llm_call', async (step) => {
      if (step.id === 'a') erase();
      return { output: GONE, tokensUsed: 0, costUsd: 0 };
    });

    await run();

    // Each write: the write, then the check, then — once there is a receipt —
    // the rewrite, all inside one transaction per write.
    expect(db.calls.slice(0, 3)).toEqual(['write', 'receipts', 'rewrite']);
    expect(db.calls.filter((c) => c === 'write').length).toBe(
      vi.mocked(prisma.$transaction).mock.calls.length
    );
  });

  it('takes them out of the error message a failed run ends with', async () => {
    registerStepType('llm_call', async (step) => {
      erase();
      throw new ExecutorError(step.id, 'bad_input', `no reply from ${GONE_ID}`);
    });

    await run();

    const failed = writes().find((w) => w.data.status === 'failed');
    expect(failed?.data.errorMessage).toContain(GONE_ID);
    expect(rowAfter().errorMessage).toBe('no reply from [erased]');
  });

  it('leaves them out of the completion event the final write is followed by', async () => {
    registerStepType('llm_call', async (step) => {
      // Erased while the last step runs: only the final write sees it.
      if (step.id === 'b') erase();
      return { output: { to: GONE, step: step.id }, tokensUsed: 0, costUsd: 0 };
    });

    const events = await run();

    const completed = events.find((e) => e.type === 'workflow_completed');
    expect(completed).toMatchObject({ output: { to: '[erased]', step: 'b' } });
  });

  it('leaves them out of the failure hook the final write is followed by', async () => {
    registerStepType('llm_call', async (step) => {
      erase();
      throw new ExecutorError(step.id, 'bad_input', `no reply from ${GONE_ID}`);
    });

    await run();

    expect(emitHookEvent).toHaveBeenCalledWith(
      'workflow.failed',
      expect.objectContaining({ reason: 'no reply from [erased]' })
    );
  });

  it('costs one query per write, and no rewrite, when nobody was erased', async () => {
    registerStepType('llm_call', async () => ({ output: GONE, tokensUsed: 0, costUsd: 0 }));

    await run();

    const transactions = vi.mocked(prisma.$transaction).mock.calls.length;
    expect(transactions).toBeGreaterThan(0);
    expect(db.calls.filter((c) => c === 'receipts')).toHaveLength(transactions);
    expect(db.calls).not.toContain('rewrite');
    expect(db.client.dataErasureReceipt.findMany).not.toHaveBeenCalled();
    // Nothing was erased, so nothing was taken out.
    expect(namesThem(rowAfter().executionTrace)).toBe(true);
  });

  it('does not check a write that lost the lease', async () => {
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 0 });
    registerStepType('llm_call', async () => ({ output: 'x', tokensUsed: 0, costUsd: 0 }));

    await run();

    expect(db.client.$queryRaw).not.toHaveBeenCalled();
  });
});
