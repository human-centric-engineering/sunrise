/**
 * Unit tests for run-claim — lease helpers for the evaluation worker.
 *
 * Covers:
 *  - claimNextRun returns null when nothing is pending
 *  - successful claim path (queued + lockedBy:null)
 *  - successful claim path (running + lockedBy:null — deliberate
 *    time-budget release; THIS IS A CRITICAL REGRESSION CASE because the
 *    worker explicitly releases mid-batch and must be able to re-acquire
 *    immediately without waiting the full orphan window)
 *  - successful claim path (running + stale lockedAt — orphan recovery)
 *  - claim race — CAS update returns count=0 → null
 *  - startedAt only stamped on first claim (not on reclaim of a released run)
 *  - missing row between updateMany and findUnique → null + warn
 *  - releaseLease clears lockedBy + lockedAt
 *  - markTerminal sets status, completedAt, summary, totalCostUsd
 *  - markTerminal omits unset patch keys (no `summary: undefined`)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEvaluationRun: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { logger } = await import('@/lib/logging');
const { claimNextRun, releaseLease, markTerminal, RUN_LEASE_TTL_MS } =
  await import('@/lib/orchestration/evaluations/run-claim');

const findFirst = prisma.aiEvaluationRun.findFirst as unknown as ReturnType<typeof vi.fn>;
const updateMany = prisma.aiEvaluationRun.updateMany as unknown as ReturnType<typeof vi.fn>;
const findUnique = prisma.aiEvaluationRun.findUnique as unknown as ReturnType<typeof vi.fn>;
const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;

function fullRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    userId: 'user-1',
    name: 'Run 1',
    subjectKind: 'agent',
    agentId: 'agent-1',
    workflowId: null,
    datasetId: 'dataset-1',
    datasetContentHash: 'h',
    metricConfigs: [],
    judgeProvider: null,
    judgeModel: null,
    subjectOutputSelector: null,
    progress: null,
    parentRunId: null,
    status: 'running',
    startedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('claimNextRun', () => {
  it('returns null when no candidate is found', async () => {
    findFirst.mockResolvedValueOnce(null);

    const claimed = await claimNextRun('worker-1');

    expect(claimed).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('claims a queued run (lockedBy:null) and stamps startedAt on first claim', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'run-1',
      status: 'queued',
      lockedAt: null,
    });
    // CAS: status update → 1 row matched
    updateMany.mockResolvedValueOnce({ count: 1 });
    // startedAt stamp → 1 row matched (first claim)
    updateMany.mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValueOnce(fullRow({ status: 'running', startedAt: new Date() }));

    const claimed = await claimNextRun('worker-1');

    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe('run-1');

    // First updateMany — CAS update
    const casCall = updateMany.mock.calls[0][0];
    expect(casCall.where.id).toBe('run-1');
    expect(casCall.data).toMatchObject({
      status: 'running',
      lockedBy: 'worker-1',
    });
    expect(casCall.data.lockedAt).toBeInstanceOf(Date);

    // Second updateMany — startedAt stamp, guarded by startedAt:null
    const stampCall = updateMany.mock.calls[1][0];
    expect(stampCall.where).toMatchObject({ id: 'run-1', startedAt: null });
    expect(stampCall.data.startedAt).toBeInstanceOf(Date);
  });

  it('claims a running run with released lease (lockedBy:null) — deliberate release case', async () => {
    // Regression guard: a worker that released its own lease mid-batch
    // must be able to re-claim on the very next tick. Without the middle
    // OR-arm (`status:'running', lockedBy:null`) the run would idle until
    // the orphan window elapsed.
    findFirst.mockResolvedValueOnce({
      id: 'run-1',
      status: 'running',
      lockedAt: null,
    });
    updateMany.mockResolvedValueOnce({ count: 1 });
    updateMany.mockResolvedValueOnce({ count: 0 }); // startedAt already set
    findUnique.mockResolvedValueOnce(
      fullRow({ status: 'running', startedAt: new Date(2024, 0, 1) })
    );

    const claimed = await claimNextRun('worker-2');
    expect(claimed?.id).toBe('run-1');
  });

  it('claims an orphaned running run (lockedAt older than orphan cutoff)', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'run-2',
      status: 'running',
      lockedAt: new Date(Date.now() - RUN_LEASE_TTL_MS - 10_000),
    });
    updateMany.mockResolvedValueOnce({ count: 1 });
    updateMany.mockResolvedValueOnce({ count: 0 });
    findUnique.mockResolvedValueOnce(fullRow({ id: 'run-2', startedAt: new Date(2024, 0, 1) }));

    const claimed = await claimNextRun('worker-3');
    expect(claimed?.id).toBe('run-2');
  });

  it('returns null when the CAS update wins zero rows (race lost)', async () => {
    findFirst.mockResolvedValueOnce({ id: 'run-1', status: 'queued', lockedAt: null });
    updateMany.mockResolvedValueOnce({ count: 0 });

    const claimed = await claimNextRun('worker-1');

    expect(claimed).toBeNull();
    // Should not progress to startedAt-stamp or findUnique.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does NOT overwrite startedAt on reclaim (predicate filters out non-null)', async () => {
    findFirst.mockResolvedValueOnce({ id: 'run-1', status: 'running', lockedAt: null });
    updateMany.mockResolvedValueOnce({ count: 1 });
    updateMany.mockResolvedValueOnce({ count: 0 }); // startedAt already set → guard matches nothing
    findUnique.mockResolvedValueOnce(fullRow({ startedAt: new Date(2024, 0, 1) }));

    const claimed = await claimNextRun('worker-1');

    expect(claimed?.startedAt).toEqual(new Date(2024, 0, 1));
    // The stamp call is still issued — its guard `startedAt:null` is what
    // makes it idempotent. Without that guard a reclaim would clobber.
    expect(updateMany.mock.calls[1][0].where.startedAt).toBeNull();
  });

  it('returns null and warns if the row disappears between updateMany and findUnique', async () => {
    findFirst.mockResolvedValueOnce({ id: 'run-1', status: 'queued', lockedAt: null });
    updateMany.mockResolvedValueOnce({ count: 1 });
    updateMany.mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValueOnce(null);

    const claimed = await claimNextRun('worker-1');

    expect(claimed).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'Claimed evaluation run disappeared before read',
      expect.objectContaining({ runId: 'run-1' })
    );
  });

  it('predicate covers all three OR arms (queued, running+null, running+stale)', async () => {
    findFirst.mockResolvedValueOnce({ id: 'run-1', status: 'queued', lockedAt: null });
    updateMany.mockResolvedValueOnce({ count: 1 });
    updateMany.mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValueOnce(fullRow());

    await claimNextRun('worker-x');

    const findCall = findFirst.mock.calls[0][0];
    expect(findCall.where.OR).toHaveLength(3);
    expect(findCall.where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'queued', lockedBy: null }),
        expect.objectContaining({ status: 'running', lockedBy: null }),
        expect.objectContaining({
          status: 'running',
          lockedAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      ])
    );

    // CAS update must use the same predicate set so a winning row is
    // still eligible at write time.
    expect(updateMany.mock.calls[0][0].where.OR).toHaveLength(3);
  });
});

describe('releaseLease', () => {
  it('clears lockedBy and lockedAt on a running run', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });

    await releaseLease('run-1');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', status: 'running' },
      data: { lockedBy: null, lockedAt: null },
    });
  });

  it('no-ops when the row is no longer running (concurrent cancel won)', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });

    // Should not throw — the status='running' predicate just made it
    // a no-op write because the cancel route already flipped status.
    await expect(releaseLease('run-1')).resolves.toBeUndefined();
  });
});

describe('markTerminal', () => {
  it('sets status + completedAt and clears lease (no patch)', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });

    const ok = await markTerminal('run-1', 'completed');

    expect(ok).toBe(true);
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'run-1', status: 'running' });
    expect(call.data).toMatchObject({
      status: 'completed',
      lockedBy: null,
      lockedAt: null,
    });
    expect(call.data.completedAt).toBeInstanceOf(Date);
    expect(call.data).not.toHaveProperty('summary');
    expect(call.data).not.toHaveProperty('totalCostUsd');
  });

  it('writes summary when patch.summary is provided', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });

    await markTerminal('run-1', 'failed', {
      summary: { note: 'dataset_changed_post_submit' },
    });

    expect(updateMany.mock.calls[0][0].data.summary).toEqual({
      note: 'dataset_changed_post_submit',
    });
  });

  it('writes totalCostUsd when patch.totalCostUsd is provided', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });

    await markTerminal('run-1', 'completed', { totalCostUsd: 1.23 });

    expect(updateMany.mock.calls[0][0].data.totalCostUsd).toBe(1.23);
  });

  it('supports cancelled status', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });

    await markTerminal('run-1', 'cancelled');

    expect(updateMany.mock.calls[0][0].data.status).toBe('cancelled');
  });

  it('omits patch keys whose values are explicitly undefined', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });

    await markTerminal('run-1', 'completed', { summary: undefined, totalCostUsd: undefined });

    const data = updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('summary');
    expect(data).not.toHaveProperty('totalCostUsd');
  });

  it('returns false when the row is no longer running (cancel won the race)', async () => {
    // Regression test for the cancel-race fix: if an admin cancels a run
    // while the worker is mid-loop, the status='running' predicate
    // prevents the worker's terminal update from clobbering 'cancelled'.
    updateMany.mockResolvedValueOnce({ count: 0 });

    const ok = await markTerminal('run-1', 'completed', { totalCostUsd: 0.42 });

    expect(ok).toBe(false);
    // The guard predicate is the load-bearing assertion here.
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: 'run-1', status: 'running' });
  });
});
