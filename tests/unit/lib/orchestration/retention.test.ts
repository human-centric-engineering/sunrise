/**
 * Tests for the retention policy enforcement.
 *
 * @see lib/orchestration/retention.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findMany: vi.fn(),
    },
    aiConversation: {
      deleteMany: vi.fn(),
    },
    aiWebhookDelivery: {
      deleteMany: vi.fn(),
    },
    aiCostLog: {
      deleteMany: vi.fn(),
    },
    aiAdminAuditLog: {
      deleteMany: vi.fn(),
    },
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import {
  enforceRetentionPolicies,
  pruneWebhookDeliveries,
  pruneCostLogs,
  pruneAuditLogs,
} from '@/lib/orchestration/retention';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('enforceRetentionPolicies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no agents, no settings, no rows to delete
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);
  });

  it('returns zeros when no agents have retention policies and no pruning configured', async () => {
    const result = await enforceRetentionPolicies();

    expect(result).toEqual({
      deleted: 0,
      agentsProcessed: 0,
      webhookDeliveriesDeleted: 0,
      costLogsDeleted: 0,
      auditLogsDeleted: 0,
    });
    expect(prisma.aiConversation.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes conversations older than retentionDays for each agent', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      { id: 'a1', slug: 'faq-bot', retentionDays: 30 },
      { id: 'a2', slug: 'support-bot', retentionDays: 90 },
    ] as never);
    vi.mocked(prisma.aiConversation.deleteMany)
      .mockResolvedValueOnce({ count: 5 } as never)
      .mockResolvedValueOnce({ count: 2 } as never);

    const result = await enforceRetentionPolicies();

    expect(result.deleted).toBe(7);
    expect(result.agentsProcessed).toBe(2);
    expect(prisma.aiConversation.deleteMany).toHaveBeenCalledTimes(2);

    // Verify first call targets agent a1 with approximately correct cutoff
    expect(prisma.aiConversation.deleteMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          agentId: 'a1',
          updatedAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      })
    );
  });

  it('handles agents where no conversations are expired', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      { id: 'a1', slug: 'faq-bot', retentionDays: 365 },
    ] as never);
    vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 0 } as never);

    const result = await enforceRetentionPolicies();

    expect(result.deleted).toBe(0);
    expect(result.agentsProcessed).toBe(1);
  });

  it('includes webhook, cost log, and audit log prune results', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: 30,
      costLogRetentionDays: 60,
      auditLogRetentionDays: 365,
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 12 } as never);
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 8 } as never);
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 3 } as never);

    const result = await enforceRetentionPolicies();

    expect(result.webhookDeliveriesDeleted).toBe(12);
    expect(result.costLogsDeleted).toBe(8);
    expect(result.auditLogsDeleted).toBe(3);
  });
});

// ─── pruneWebhookDeliveries ─────────────────────────────────────────────────

describe('pruneWebhookDeliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when no maxAgeDays passed and no setting configured', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    const result = await pruneWebhookDeliveries();

    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiWebhookDelivery.deleteMany).not.toHaveBeenCalled();
  });

  it('skips when setting row exists but webhookRetentionDays is null', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: null,
    } as never);

    const result = await pruneWebhookDeliveries();

    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiWebhookDelivery.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes rows older than configured webhookRetentionDays', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: 14,
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 25 } as never);

    const result = await pruneWebhookDeliveries();

    expect(result).toEqual({ deleted: 25 });
    expect(prisma.aiWebhookDelivery.deleteMany).toHaveBeenCalledTimes(1);

    expect(prisma.aiWebhookDelivery.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      })
    );
  });

  it('uses explicit maxAgeDays over settings', async () => {
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 3 } as never);

    const result = await pruneWebhookDeliveries(7);

    expect(result).toEqual({ deleted: 3 });
    // Should not read settings when explicit value passed
    expect(prisma.aiOrchestrationSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.aiWebhookDelivery.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      })
    );
  });

  it('returns deleted: 0 when no rows match cutoff', async () => {
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 0 } as never);

    const result = await pruneWebhookDeliveries(30);

    expect(result).toEqual({ deleted: 0 });
  });
});

// ─── pruneCostLogs ──────────────────────────────────────────────────────────

describe('pruneCostLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when no maxAgeDays passed and no setting configured', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    const result = await pruneCostLogs();

    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiCostLog.deleteMany).not.toHaveBeenCalled();
  });

  it('skips when setting row exists but costLogRetentionDays is null', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      costLogRetentionDays: null,
    } as never);

    const result = await pruneCostLogs();

    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiCostLog.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes rows older than configured costLogRetentionDays', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      costLogRetentionDays: 60,
    } as never);
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 100 } as never);

    const result = await pruneCostLogs();

    expect(result).toEqual({ deleted: 100 });
    expect(prisma.aiCostLog.deleteMany).toHaveBeenCalledTimes(1);

    expect(prisma.aiCostLog.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      })
    );
  });

  it('uses explicit maxAgeDays over settings', async () => {
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 5 } as never);

    const result = await pruneCostLogs(90);

    expect(result).toEqual({ deleted: 5 });
    expect(prisma.aiOrchestrationSettings.findUnique).not.toHaveBeenCalled();
  });

  it('handles settings lookup failure gracefully', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue(
      new Error('DB connection lost')
    );

    const result = await pruneCostLogs();

    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiCostLog.deleteMany).not.toHaveBeenCalled();
  });
});

// ─── pruneAuditLogs ─────────────────────────────────────────────────────────

describe('pruneAuditLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when no maxAgeDays passed and no setting configured', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    const result = await pruneAuditLogs();

    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiAdminAuditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('skips when setting row exists but auditLogRetentionDays is null', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      auditLogRetentionDays: null,
    } as never);

    const result = await pruneAuditLogs();

    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiAdminAuditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes rows older than configured auditLogRetentionDays', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      auditLogRetentionDays: 365,
    } as never);
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 42 } as never);

    const result = await pruneAuditLogs();

    expect(result).toEqual({ deleted: 42 });
    expect(prisma.aiAdminAuditLog.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      })
    );
  });

  it('uses explicit maxAgeDays over settings', async () => {
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 5 } as never);

    const result = await pruneAuditLogs(30);

    expect(result).toEqual({ deleted: 5 });
    expect(prisma.aiOrchestrationSettings.findUnique).not.toHaveBeenCalled();
  });

  it('returns deleted: 0 when no rows match cutoff', async () => {
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 0 } as never);

    const result = await pruneAuditLogs(90);

    expect(result).toEqual({ deleted: 0 });
  });
});
