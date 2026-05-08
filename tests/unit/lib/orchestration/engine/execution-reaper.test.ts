/**
 * Tests for the execution reaper — marks zombie, stale pending, and abandoned executions as failed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';

const mockUpdateMany = prisma.aiWorkflowExecution.updateMany as ReturnType<typeof vi.fn>;

/** Helper: mock all three updateMany calls with given counts. */
function mockCounts(running: number, pending: number, approvals: number) {
  mockUpdateMany
    .mockResolvedValueOnce({ count: running })
    .mockResolvedValueOnce({ count: pending })
    .mockResolvedValueOnce({ count: approvals });
}

describe('reapZombieExecutions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks stale running executions as failed with errorMessage', async () => {
    mockCounts(3, 0, 0);

    const result = await reapZombieExecutions();

    expect(result.reaped).toBe(3);
    expect(result.stalePending).toBe(0);
    expect(result.abandonedApprovals).toBe(0);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'running',
          updatedAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
        data: expect.objectContaining({
          status: 'failed',
          completedAt: expect.any(Date),
          errorMessage: expect.stringContaining('zombie threshold'),
        }),
      })
    );
  });

  it('marks stale pending executions as failed', async () => {
    mockCounts(0, 2, 0);

    const result = await reapZombieExecutions();

    expect(result.reaped).toBe(0);
    expect(result.stalePending).toBe(2);
    expect(result.abandonedApprovals).toBe(0);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'pending',
          createdAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
        data: expect.objectContaining({
          status: 'failed',
          completedAt: expect.any(Date),
          errorMessage: expect.stringContaining('did not reconnect'),
        }),
      })
    );
  });

  it('marks stale paused_for_approval executions as failed', async () => {
    mockCounts(0, 0, 2);

    const result = await reapZombieExecutions();

    expect(result.reaped).toBe(0);
    expect(result.stalePending).toBe(0);
    expect(result.abandonedApprovals).toBe(2);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'paused_for_approval',
          updatedAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
        data: expect.objectContaining({
          status: 'failed',
          completedAt: expect.any(Date),
          errorMessage: expect.stringContaining('approval not received'),
        }),
      })
    );
  });

  it('returns zero when nothing to reap', async () => {
    mockCounts(0, 0, 0);

    const result = await reapZombieExecutions();

    expect(result.reaped).toBe(0);
    expect(result.stalePending).toBe(0);
    expect(result.abandonedApprovals).toBe(0);
  });

  // Lease coherence — reaper must clear lease columns alongside the FAILED flip so a
  // reaper-killed RUNNING row can't be picked back up by claimLease (the orphan-sweep
  // race scenario from PR #167 code review).
  it('all three FAILED writes clear leaseToken and leaseExpiresAt to null', async () => {
    mockCounts(1, 1, 1);

    await reapZombieExecutions();

    expect(mockUpdateMany).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const data = mockUpdateMany.mock.calls[i][0].data as Record<string, unknown>;
      expect(data['leaseToken']).toBeNull();
      expect(data['leaseExpiresAt']).toBeNull();
    }
  });

  it('accepts custom thresholds', async () => {
    mockCounts(1, 1, 1);

    const fiveMinutes = 5 * 60 * 1000;
    const thirtyMinutes = 30 * 60 * 1000;
    const oneDay = 24 * 60 * 60 * 1000;
    await reapZombieExecutions(fiveMinutes, thirtyMinutes, oneDay);

    const runningCall = mockUpdateMany.mock.calls[0][0];
    const runningCutoff = runningCall.where.updatedAt.lt as Date;
    expect(Date.now() - runningCutoff.getTime()).toBeGreaterThan(fiveMinutes - 2000);
    expect(Date.now() - runningCutoff.getTime()).toBeLessThan(fiveMinutes + 2000);

    const pendingCall = mockUpdateMany.mock.calls[1][0];
    const pendingCutoff = pendingCall.where.createdAt.lt as Date;
    expect(Date.now() - pendingCutoff.getTime()).toBeGreaterThan(thirtyMinutes - 2000);
    expect(Date.now() - pendingCutoff.getTime()).toBeLessThan(thirtyMinutes + 2000);

    const approvalCall = mockUpdateMany.mock.calls[2][0];
    const approvalCutoff = approvalCall.where.updatedAt.lt as Date;
    expect(Date.now() - approvalCutoff.getTime()).toBeGreaterThan(oneDay - 2000);
    expect(Date.now() - approvalCutoff.getTime()).toBeLessThan(oneDay + 2000);
  });
});
