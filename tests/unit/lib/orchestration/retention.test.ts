/**
 * Tests for the retention policy enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findMany: vi.fn(),
    },
    aiConversation: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';

describe('enforceRetentionPolicies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when no agents have retention policies', async () => {
    (prisma.aiAgent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await enforceRetentionPolicies();

    expect(result).toEqual({ deleted: 0, agentsProcessed: 0 });
    expect(prisma.aiConversation.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes conversations older than retentionDays for each agent', async () => {
    (prisma.aiAgent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'a1', slug: 'faq-bot', retentionDays: 30 },
      { id: 'a2', slug: 'support-bot', retentionDays: 90 },
    ]);
    (prisma.aiConversation.deleteMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ count: 5 })
      .mockResolvedValueOnce({ count: 2 });

    const result = await enforceRetentionPolicies();

    expect(result).toEqual({ deleted: 7, agentsProcessed: 2 });
    expect(prisma.aiConversation.deleteMany).toHaveBeenCalledTimes(2);

    // Verify cutoff date is approximately correct for 30-day agent
    const firstCall = (prisma.aiConversation.deleteMany as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(firstCall.where.agentId).toBe('a1');
    const cutoff = firstCall.where.updatedAt.lt as Date;
    const expectedCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(2000);
  });

  it('handles agents where no conversations are expired', async () => {
    (prisma.aiAgent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'a1', slug: 'faq-bot', retentionDays: 365 },
    ]);
    (prisma.aiConversation.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

    const result = await enforceRetentionPolicies();

    expect(result).toEqual({ deleted: 0, agentsProcessed: 1 });
  });
});
