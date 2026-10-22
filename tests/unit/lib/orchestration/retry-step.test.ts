/**
 * Unit tests: preparing a failed run to resume from a failed step (§122 t-901).
 *
 * The route's own tests (`executions.id.retry-step.test.ts`) cover the
 * request and the trace cut. These prove the part t-901 added: the run is
 * locked before it is read, and the read and the write are one transaction.
 *
 * @see lib/orchestration/retry-step.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  aiWorkflowExecution: { findUnique: vi.fn(), updateMany: vi.fn() },
  aiWorkflowRunningStep: { deleteMany: vi.fn() },
}));
const prismaMock = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { prepareRetryStep } from '@/lib/orchestration/retry-step';
import { NotFoundError, ValidationError } from '@/lib/api/errors';

const entry = (stepId: string, status: 'completed' | 'failed') => ({
  stepId,
  stepType: 'llm_call',
  label: stepId,
  status,
  output: null,
  tokensUsed: 10,
  costUsd: 0.5,
  startedAt: '2026-10-22T00:00:00Z',
  durationMs: 1,
});

const failedRun = {
  id: 'exec-1',
  workflowId: 'wf-1',
  status: 'failed',
  executionTrace: [entry('a', 'completed'), entry('b', 'failed')],
};

let inTransaction = false;
beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(
    async (run: (client: typeof tx) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await run(tx);
      } finally {
        inTransaction = false;
      }
    }
  );
  tx.$queryRaw.mockResolvedValue([]);
  tx.aiWorkflowExecution.findUnique.mockResolvedValue(failedRun);
  tx.aiWorkflowExecution.updateMany.mockResolvedValue({ count: 1 });
  tx.aiWorkflowRunningStep.deleteMany.mockResolvedValue({ count: 0 });
});

describe('prepareRetryStep', () => {
  it('locks the run, then reads and writes it, all in one transaction', async () => {
    const order: string[] = [];
    tx.$queryRaw.mockImplementation(async () => {
      order.push(`lock:${String(inTransaction)}`);
      return [];
    });
    tx.aiWorkflowExecution.findUnique.mockImplementation(async () => {
      order.push(`read:${String(inTransaction)}`);
      return failedRun;
    });
    tx.aiWorkflowExecution.updateMany.mockImplementation(async () => {
      order.push(`write:${String(inTransaction)}`);
      return { count: 1 };
    });

    const result = await prepareRetryStep('exec-1', 'b', () => true);

    expect(order).toEqual(['lock:true', 'read:true', 'write:true']);
    expect(result).toEqual({ workflowId: 'wf-1', keptSteps: 1 });
    expect(tx.aiWorkflowExecution.updateMany).toHaveBeenCalledWith({
      where: { id: 'exec-1', status: 'failed' },
      data: expect.objectContaining({
        status: 'pending',
        executionTrace: [entry('a', 'completed')],
        totalTokensUsed: 10,
        totalCostUsd: 0.5,
        currentStep: 'a',
        errorMessage: null,
      }),
    });
    expect(tx.aiWorkflowRunningStep.deleteMany).toHaveBeenCalledWith({
      where: { executionId: 'exec-1' },
    });
  });

  it('answers not found for a run the caller may not see, writing nothing', async () => {
    await expect(prepareRetryStep('exec-1', 'b', () => false)).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(tx.aiWorkflowExecution.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a second retry that got the lock after the first, sweeping nothing', async () => {
    tx.aiWorkflowExecution.updateMany.mockResolvedValue({ count: 0 });

    await expect(prepareRetryStep('exec-1', 'b', () => true)).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(tx.aiWorkflowRunningStep.deleteMany).not.toHaveBeenCalled();
  });
});
