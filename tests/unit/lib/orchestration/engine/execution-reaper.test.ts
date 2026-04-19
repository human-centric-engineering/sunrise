/**
 * Tests for the execution reaper — marks zombie executions as failed.
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

describe('reapZombieExecutions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks stale running executions as failed', async () => {
    (prisma.aiWorkflowExecution.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 3,
    });

    const result = await reapZombieExecutions();

    expect(result.reaped).toBe(3);
    expect(prisma.aiWorkflowExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'running',
          startedAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
        data: expect.objectContaining({
          status: 'failed',
          completedAt: expect.any(Date),
        }),
      })
    );
  });

  it('returns zero when no zombies found', async () => {
    (prisma.aiWorkflowExecution.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 0,
    });

    const result = await reapZombieExecutions();

    expect(result.reaped).toBe(0);
  });

  it('accepts custom threshold', async () => {
    (prisma.aiWorkflowExecution.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 1,
    });

    const fiveMinutes = 5 * 60 * 1000;
    await reapZombieExecutions(fiveMinutes);

    const call = (prisma.aiWorkflowExecution.updateMany as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const cutoff = call.where.startedAt.lt as Date;
    // Cutoff should be approximately 5 minutes ago (within 2s tolerance)
    expect(Date.now() - cutoff.getTime()).toBeGreaterThan(fiveMinutes - 2000);
    expect(Date.now() - cutoff.getTime()).toBeLessThan(fiveMinutes + 2000);
  });
});
