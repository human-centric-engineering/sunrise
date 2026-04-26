/**
 * Tests for the execution reaper — marks zombie and abandoned executions as failed.
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

describe('reapZombieExecutions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks stale running executions as failed with errorMessage', async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 3 }) // running zombies
      .mockResolvedValueOnce({ count: 0 }); // abandoned approvals

    const result = await reapZombieExecutions();

    expect(result.reaped).toBe(3);
    expect(result.abandonedApprovals).toBe(0);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'running',
          startedAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
        data: expect.objectContaining({
          status: 'failed',
          completedAt: expect.any(Date),
          errorMessage: expect.stringContaining('zombie threshold'),
        }),
      })
    );
  });

  it('marks stale paused_for_approval executions as failed', async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 0 }) // running zombies
      .mockResolvedValueOnce({ count: 2 }); // abandoned approvals

    const result = await reapZombieExecutions();

    expect(result.reaped).toBe(0);
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

  it('returns zero when no zombies or abandoned approvals found', async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });

    const result = await reapZombieExecutions();

    expect(result.reaped).toBe(0);
    expect(result.abandonedApprovals).toBe(0);
  });

  it('accepts custom thresholds', async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });

    const fiveMinutes = 5 * 60 * 1000;
    const oneDay = 24 * 60 * 60 * 1000;
    await reapZombieExecutions(fiveMinutes, oneDay);

    const runningCall = mockUpdateMany.mock.calls[0][0];
    const runningCutoff = runningCall.where.startedAt.lt as Date;
    expect(Date.now() - runningCutoff.getTime()).toBeGreaterThan(fiveMinutes - 2000);
    expect(Date.now() - runningCutoff.getTime()).toBeLessThan(fiveMinutes + 2000);

    const approvalCall = mockUpdateMany.mock.calls[1][0];
    const approvalCutoff = approvalCall.where.updatedAt.lt as Date;
    expect(Date.now() - approvalCutoff.getTime()).toBeGreaterThan(oneDay - 2000);
    expect(Date.now() - approvalCutoff.getTime()).toBeLessThan(oneDay + 2000);
  });
});
