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
    aiEventHookDelivery: {
      deleteMany: vi.fn(),
    },
    aiCostLog: {
      deleteMany: vi.fn(),
    },
    aiAdminAuditLog: {
      deleteMany: vi.fn(),
    },
    aiWorkflowExecution: {
      deleteMany: vi.fn(),
    },
    aiEvaluationSession: {
      deleteMany: vi.fn(),
    },
    aiEvaluationRun: {
      deleteMany: vi.fn(),
    },
    mcpAuditLog: {
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

vi.mock('@/lib/orchestration/mcp/config', () => ({
  getMcpServerConfig: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getMcpServerConfig } from '@/lib/orchestration/mcp/config';
import {
  enforceRetentionPolicies,
  enforceSystemRetentionPolicies,
  pruneWebhookDeliveries,
  pruneHookDeliveries,
  pruneCostLogs,
  pruneAuditLogs,
  pruneExecutions,
  pruneEvaluationData,
  pruneMcpAuditLogs,
} from '@/lib/orchestration/retention';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('enforceRetentionPolicies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no agents, no settings, no rows to delete
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEventHookDelivery.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiWorkflowExecution.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEvaluationSession.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEvaluationRun.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);
    // MCP audit pruning is always on (non-nullable, default 90)
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      isEnabled: false,
      serverName: 'Test MCP Server',
      serverVersion: '1.0.0',
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 90,
    });
  });

  it('returns zeros when no agents have retention policies and no pruning configured', async () => {
    const result = await enforceRetentionPolicies();

    expect(result).toEqual({
      deleted: 0,
      agentsProcessed: 0,
      webhookDeliveriesDeleted: 0,
      hookDeliveriesDeleted: 0,
      costLogsDeleted: 0,
      executionsDeleted: 0,
      evaluationSessionsDeleted: 0,
      evaluationRunsDeleted: 0,
    });
    expect(prisma.aiConversation.deleteMany).not.toHaveBeenCalled();
    // Execution/evaluation deletes ARE skipped when settings return null
    expect(prisma.aiWorkflowExecution.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiEvaluationSession.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiEvaluationRun.deleteMany).not.toHaveBeenCalled();
  });

  it('never touches the two system audit tables — those are the system sweep’s (§108)', async () => {
    // The tenant sweep runs once per org inside that org's scope. The audit
    // tables have no org, so pruning them here would repeat the same delete N
    // times at `multi`; `enforceSystemRetentionPolicies` owns them.
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      auditLogRetentionDays: 365,
    } as never);

    await enforceRetentionPolicies();

    expect(prisma.aiAdminAuditLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.mcpAuditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes conversations older than retentionDays for each agent', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      { id: 'a1', slug: 'faq-bot', retentionDays: 30 },
      { id: 'a2', slug: 'support-bot', retentionDays: 90 },
    ] as never);
    vi.mocked(prisma.aiConversation.deleteMany)
      .mockResolvedValueOnce({ count: 5 })
      .mockResolvedValueOnce({ count: 2 });

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
    vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 0 });

    const result = await enforceRetentionPolicies();

    expect(result.deleted).toBe(0);
    expect(result.agentsProcessed).toBe(1);
  });

  it('includes webhook, cost log, execution and evaluation prune results', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: 30,
      costLogRetentionDays: 60,
      auditLogRetentionDays: 365,
      executionRetentionDays: 90,
      evaluationRetentionDays: 90,
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 12 });
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 8 });
    vi.mocked(prisma.aiWorkflowExecution.deleteMany).mockResolvedValue({ count: 5 });
    vi.mocked(prisma.aiEvaluationSession.deleteMany).mockResolvedValue({ count: 4 });
    vi.mocked(prisma.aiEvaluationRun.deleteMany).mockResolvedValue({ count: 7 });

    const result = await enforceRetentionPolicies();

    // With DLQ retention falling back to webhookRetentionDays the prune
    // runs twice (base + DLQ slice), each returning the mocked count.
    expect(result.webhookDeliveriesDeleted).toBe(24);
    expect(result.costLogsDeleted).toBe(8);
    expect(result.executionsDeleted).toBe(5);
    // Different counts (4 vs 7) prove the two fields aren't swapped
    expect(result.evaluationSessionsDeleted).toBe(4);
    expect(result.evaluationRunsDeleted).toBe(7);
  });

  it('reads the settings row exactly once for the whole sweep (#442)', async () => {
    // Every prune used to resolve its own window from the same singleton row —
    // eight round-trips to fetch six columns, 1,440 times a day.
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: 30,
      webhookDlqRetentionDays: 60,
      costLogRetentionDays: 60,
      auditLogRetentionDays: 365,
      executionRetentionDays: 90,
      evaluationRetentionDays: 90,
    } as never);

    await enforceRetentionPolicies();

    expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(1);
    // Every column this sweep uses, in that one read, so no prune has to go
    // back for its own. `auditLogRetentionDays` is absent on purpose: the
    // admin audit log moved to the system sweep (§108), and selecting it here
    // would read a column nothing in this sweep consumes.
    expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledWith({
      where: { slug: 'global' },
      select: {
        webhookRetentionDays: true,
        webhookDlqRetentionDays: true,
        costLogRetentionDays: true,
        executionRetentionDays: true,
        evaluationRetentionDays: true,
      },
    });
  });

  it('skips every prune without re-reading settings when the row is missing', async () => {
    // A fresh install has no settings row. The hoisted read must not degrade
    // into each prune looking the row up again.
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    await enforceRetentionPolicies();

    expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.aiWebhookDelivery.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiEventHookDelivery.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiCostLog.deleteMany).not.toHaveBeenCalled();
  });

  it('swallows a settings-read failure and completes the sweep with nothing pruned', async () => {
    // The pre-existing contract: a transient settings failure skips the
    // configurable prunes rather than throwing out of the sweep.
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue(
      new Error('settings read failed')
    );

    const result = await enforceRetentionPolicies();

    expect(result.webhookDeliveriesDeleted).toBe(0);
    expect(result.executionsDeleted).toBe(0);
    expect(prisma.aiWorkflowExecution.deleteMany).not.toHaveBeenCalled();
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

  it('deletes both non-exhausted and exhausted rows when DLQ retention is null (falls back to base)', async () => {
    // Settings: webhookRetentionDays=14, webhookDlqRetentionDays=null
    // DLQ falls back to the base value, so we expect TWO deleteMany
    // calls — one scoped to pending/delivered/failed, one to exhausted —
    // both with the same 14-day cutoff.
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: 14,
      webhookDlqRetentionDays: null,
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 12 });

    const result = await pruneWebhookDeliveries();

    expect(result).toEqual({ deleted: 24 });
    expect(prisma.aiWebhookDelivery.deleteMany).toHaveBeenCalledTimes(2);

    const calls = vi.mocked(prisma.aiWebhookDelivery.deleteMany).mock.calls;
    const statuses = calls.map((c) => (c[0]?.where as Record<string, unknown>).status);
    expect(statuses).toEqual(
      expect.arrayContaining([{ in: ['pending', 'delivered', 'failed'] }, 'exhausted'])
    );
  });

  it('uses webhookDlqRetentionDays for exhausted rows when set', async () => {
    // Base 7 days, DLQ 30 days — exhausted rows live longer than the
    // rest. Both queries should run with their respective cutoffs.
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: 7,
      webhookDlqRetentionDays: 30,
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 4 });

    const result = await pruneWebhookDeliveries();

    expect(result).toEqual({ deleted: 8 });
    const calls = vi.mocked(prisma.aiWebhookDelivery.deleteMany).mock.calls;
    expect(calls).toHaveLength(2);

    const baseCall = calls.find(
      (c) => (c[0]?.where as Record<string, unknown>).status !== 'exhausted'
    );
    const dlqCall = calls.find(
      (c) => (c[0]?.where as Record<string, unknown>).status === 'exhausted'
    );
    expect(baseCall).toBeDefined();
    expect(dlqCall).toBeDefined();

    const now = Date.now();
    const baseCutoff = (baseCall![0]!.where as Record<string, { lt: Date }>).createdAt.lt;
    const dlqCutoff = (dlqCall![0]!.where as Record<string, { lt: Date }>).createdAt.lt;
    // Cutoffs are now - days*24h; later cutoff means closer to now.
    // Base (7d) cutoff is closer to now than DLQ (30d) cutoff.
    expect(now - baseCutoff.getTime()).toBeLessThan(now - dlqCutoff.getTime());
  });

  it('honours explicit maxAgeDays + dlqMaxAgeDays args over settings', async () => {
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 3 });

    const result = await pruneWebhookDeliveries(7, 90);

    expect(result).toEqual({ deleted: 6 });
    // Should not consult settings when both explicit values supplied.
    expect(prisma.aiOrchestrationSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.aiWebhookDelivery.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('only deletes DLQ rows when base retention is null but DLQ retention is set', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: null,
      webhookDlqRetentionDays: 30,
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 5 });

    const result = await pruneWebhookDeliveries();

    expect(result).toEqual({ deleted: 5 });
    expect(prisma.aiWebhookDelivery.deleteMany).toHaveBeenCalledTimes(1);
    const onlyCall = vi.mocked(prisma.aiWebhookDelivery.deleteMany).mock.calls[0][0];
    expect((onlyCall?.where as Record<string, unknown>).status).toBe('exhausted');
  });

  it('returns deleted: 0 when no rows match cutoff', async () => {
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 0 });

    const result = await pruneWebhookDeliveries(30, 30);

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
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 100 });

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
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 5 });

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
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 42 });

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
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 5 });

    const result = await pruneAuditLogs(30);

    expect(result).toEqual({ deleted: 5 });
    expect(prisma.aiOrchestrationSettings.findUnique).not.toHaveBeenCalled();
  });

  it('returns deleted: 0 when no rows match cutoff', async () => {
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 0 });

    const result = await pruneAuditLogs(90);

    expect(result).toEqual({ deleted: 0 });
  });
});

// ─── pruneHookDeliveries ────────────────────────────────────────────────────

describe('pruneHookDeliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when webhookRetentionDays is null in settings', async () => {
    // Arrange — settings row exists but the field is null
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: null,
    } as never);

    // Act
    const result = await pruneHookDeliveries();

    // Assert — no delete, returns zero
    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiEventHookDelivery.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes rows older than webhookRetentionDays and returns the count', async () => {
    // Arrange — settings says 30 days; 5 rows match
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: 30,
    } as never);
    vi.mocked(prisma.aiEventHookDelivery.deleteMany).mockResolvedValue({ count: 5 });

    // Act
    const result = await pruneHookDeliveries();

    // Assert — correct count returned
    expect(result).toEqual({ deleted: 5 });

    // deleteMany called with a createdAt cutoff (non-brittle: any Date)
    expect(prisma.aiEventHookDelivery.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      })
    );
  });

  it('uses explicit maxAgeDays arg and does not read settings', async () => {
    // Arrange — settings row is present with a different value; explicit arg should win
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: 90,
    } as never);
    vi.mocked(prisma.aiEventHookDelivery.deleteMany).mockResolvedValue({ count: 2 });

    // Act — explicit override
    const result = await pruneHookDeliveries(7);

    // Assert — settings lookup was skipped (explicit arg bypasses it)
    expect(prisma.aiOrchestrationSettings.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 2 });
    expect(prisma.aiEventHookDelivery.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      })
    );
  });
});

// ─── enforceRetentionPolicies — hookDeliveriesDeleted field ────────────────

describe('enforceRetentionPolicies (hookDeliveriesDeleted)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEventHookDelivery.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiWorkflowExecution.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEvaluationSession.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEvaluationRun.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      isEnabled: false,
      serverName: 'Test MCP Server',
      serverVersion: '1.0.0',
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 90,
    });
  });

  it('reflects hook delivery prune count in result.hookDeliveriesDeleted', async () => {
    // Arrange — settings returns webhookRetentionDays so pruneHookDeliveries runs;
    // aiEventHookDelivery.deleteMany returns 7
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      webhookRetentionDays: 30,
      costLogRetentionDays: null,
      auditLogRetentionDays: null,
    } as never);
    vi.mocked(prisma.aiEventHookDelivery.deleteMany).mockResolvedValue({ count: 7 });

    // Act
    const result = await enforceRetentionPolicies();

    // Assert — hookDeliveriesDeleted correctly surfaces the deleteMany count
    expect(result.hookDeliveriesDeleted).toBe(7);
  });
});

// ─── pruneExecutions ─────────────────────────────────────────────────────────

describe('pruneExecutions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when no maxAgeDays passed and no setting configured', async () => {
    // Arrange
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    // Act
    const result = await pruneExecutions();

    // Assert
    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiWorkflowExecution.deleteMany).not.toHaveBeenCalled();
  });

  it('skips when setting row exists but executionRetentionDays is null', async () => {
    // Arrange
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      executionRetentionDays: null,
    } as never);

    // Act
    const result = await pruneExecutions();

    // Assert
    expect(result).toEqual({ deleted: 0 });
    expect(prisma.aiWorkflowExecution.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes only terminal executions (completed/failed/cancelled) — status filter is the contract', async () => {
    // Arrange — 90-day window configured; 15 rows match
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      executionRetentionDays: 90,
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.deleteMany).mockResolvedValue({ count: 15 });

    // Act
    const result = await pruneExecutions();

    // Assert — returned count
    expect(result).toEqual({ deleted: 15 });
    expect(prisma.aiWorkflowExecution.deleteMany).toHaveBeenCalledTimes(1);

    // Anti-green-bar: the status filter is the safety property of this function.
    // If the source removed the status filter, in-flight executions would be
    // destroyed. A test that only checked the count would not catch that regression.
    const call = vi.mocked(prisma.aiWorkflowExecution.deleteMany).mock.calls[0][0];
    expect((call?.where as Record<string, unknown>).status).toEqual({
      in: ['completed', 'failed', 'cancelled'],
    });
    // Cutoff is a Date approximately `now - 90 * 24h`
    expect((call?.where as Record<string, { lt: Date }>).createdAt.lt).toBeInstanceOf(Date);
  });

  it('uses explicit maxAgeDays arg and does not read settings', async () => {
    // Arrange
    vi.mocked(prisma.aiWorkflowExecution.deleteMany).mockResolvedValue({ count: 3 });

    // Act
    const result = await pruneExecutions(30);

    // Assert — settings lookup was skipped
    expect(prisma.aiOrchestrationSettings.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 3 });
  });

  it('passes a cutoff date approximately now minus maxAgeDays', async () => {
    // Arrange
    vi.mocked(prisma.aiWorkflowExecution.deleteMany).mockResolvedValue({ count: 0 });
    const beforeMs = Date.now();

    // Act
    await pruneExecutions(7);

    const afterMs = Date.now();
    const call = vi.mocked(prisma.aiWorkflowExecution.deleteMany).mock.calls[0][0];
    const cutoff = (call?.where as Record<string, { lt: Date }>).createdAt.lt;
    const expectedMs = 7 * 24 * 60 * 60 * 1000;
    // Cutoff should fall between (beforeMs - 7d) and (afterMs - 7d)
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(beforeMs - expectedMs - 100);
    expect(cutoff.getTime()).toBeLessThanOrEqual(afterMs - expectedMs + 100);
  });
});

// ─── pruneEvaluationData ─────────────────────────────────────────────────────

describe('pruneEvaluationData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when no maxAgeDays passed and no setting configured', async () => {
    // Arrange
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    // Act
    const result = await pruneEvaluationData();

    // Assert
    expect(result).toEqual({ sessionsDeleted: 0, runsDeleted: 0 });
    expect(prisma.aiEvaluationSession.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiEvaluationRun.deleteMany).not.toHaveBeenCalled();
  });

  it('skips when setting row exists but evaluationRetentionDays is null', async () => {
    // Arrange
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      evaluationRetentionDays: null,
    } as never);

    // Act
    const result = await pruneEvaluationData();

    // Assert
    expect(result).toEqual({ sessionsDeleted: 0, runsDeleted: 0 });
    expect(prisma.aiEvaluationSession.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiEvaluationRun.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes terminal sessions and runs with correct status filters — safety property', async () => {
    // Arrange — use distinct counts (4 vs 7) so a swapped-field bug is caught
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      evaluationRetentionDays: 60,
    } as never);
    vi.mocked(prisma.aiEvaluationSession.deleteMany).mockResolvedValue({ count: 4 });
    vi.mocked(prisma.aiEvaluationRun.deleteMany).mockResolvedValue({ count: 7 });

    // Act
    const result = await pruneEvaluationData();

    // Assert — counts map to the correct fields (different values catch field swap)
    expect(result).toEqual({ sessionsDeleted: 4, runsDeleted: 7 });

    // Anti-green-bar: the status filters are the safety properties.
    // Sessions: only completed/archived — not in-progress/draft
    const sessionCall = vi.mocked(prisma.aiEvaluationSession.deleteMany).mock.calls[0][0];
    expect((sessionCall?.where as Record<string, unknown>).status).toEqual({
      in: ['completed', 'archived'],
    });

    // Runs: only completed/failed/cancelled — not queued/running
    const runCall = vi.mocked(prisma.aiEvaluationRun.deleteMany).mock.calls[0][0];
    expect((runCall?.where as Record<string, unknown>).status).toEqual({
      in: ['completed', 'failed', 'cancelled'],
    });
  });

  it('uses explicit maxAgeDays arg and does not read settings', async () => {
    // Arrange
    vi.mocked(prisma.aiEvaluationSession.deleteMany).mockResolvedValue({ count: 2 });
    vi.mocked(prisma.aiEvaluationRun.deleteMany).mockResolvedValue({ count: 3 });

    // Act
    const result = await pruneEvaluationData(45);

    // Assert — settings lookup was skipped
    expect(prisma.aiOrchestrationSettings.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual({ sessionsDeleted: 2, runsDeleted: 3 });
  });

  it('passes a cutoff date approximately now minus maxAgeDays', async () => {
    // Arrange
    vi.mocked(prisma.aiEvaluationSession.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEvaluationRun.deleteMany).mockResolvedValue({ count: 0 });
    const beforeMs = Date.now();

    // Act
    await pruneEvaluationData(30);

    const afterMs = Date.now();
    const sessionCall = vi.mocked(prisma.aiEvaluationSession.deleteMany).mock.calls[0][0];
    const cutoff = (sessionCall?.where as Record<string, { lt: Date }>).createdAt.lt;
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(beforeMs - expectedMs - 100);
    expect(cutoff.getTime()).toBeLessThanOrEqual(afterMs - expectedMs + 100);
  });
});

// ─── enforceSystemRetentionPolicies ──────────────────────────────────────────

describe('enforceSystemRetentionPolicies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      isEnabled: false,
      serverName: 'Test MCP Server',
      serverVersion: '1.0.0',
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 90,
    });
  });

  it('prunes both audit tables and reports each count', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      auditLogRetentionDays: 365,
    } as never);
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 3 });
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 11 });

    const result = await enforceSystemRetentionPolicies();

    // Different counts prove the two fields aren't swapped.
    expect(result).toEqual({ auditLogsDeleted: 3, mcpAuditLogsDeleted: 11 });
    expect(prisma.aiAdminAuditLog.deleteMany).toHaveBeenCalledOnce();
    expect(prisma.mcpAuditLog.deleteMany).toHaveBeenCalledOnce();
  });

  it('skips the admin audit prune when no window is configured, but MCP audit pruning is always on', async () => {
    const result = await enforceSystemRetentionPolicies();

    expect(result).toEqual({ auditLogsDeleted: 0, mcpAuditLogsDeleted: 0 });
    expect(prisma.aiAdminAuditLog.deleteMany).not.toHaveBeenCalled();
    // Non-nullable window (default 90) — the delete runs, returning count 0.
    expect(prisma.mcpAuditLog.deleteMany).toHaveBeenCalledOnce();
  });

  it('touches no tenant-owned table', async () => {
    await enforceSystemRetentionPolicies();

    expect(prisma.aiAgent.findMany).not.toHaveBeenCalled();
    expect(prisma.aiConversation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiWorkflowExecution.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiCostLog.deleteMany).not.toHaveBeenCalled();
  });
});

// ─── pruneMcpAuditLogs ───────────────────────────────────────────────────────

describe('pruneMcpAuditLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: always-on, 90-day default
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      isEnabled: false,
      serverName: 'Test MCP Server',
      serverVersion: '1.0.0',
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 90,
    });
  });

  it('runs with the default 90-day window from getMcpServerConfig when no arg is passed', async () => {
    // Arrange — 6 rows match the 90-day cutoff
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 6 });

    // Act
    const result = await pruneMcpAuditLogs();

    // Assert — always on; did not require a settings row
    expect(getMcpServerConfig).toHaveBeenCalledOnce();
    expect(result).toEqual({ deleted: 6 });
    expect(prisma.mcpAuditLog.deleteMany).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.mcpAuditLog.deleteMany).mock.calls[0][0];
    expect((call?.where as Record<string, { lt: Date }>).createdAt.lt).toBeInstanceOf(Date);
  });

  it('skips deleteMany when auditRetentionDays is <= 0', async () => {
    // Arrange — misconfigured zero means "skip" by contract
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      isEnabled: false,
      serverName: 'Test MCP Server',
      serverVersion: '1.0.0',
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 0,
    });

    // Act
    const result = await pruneMcpAuditLogs();

    // Assert — skip guard works; deleteMany never called
    expect(result).toEqual({ deleted: 0 });
    expect(prisma.mcpAuditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('skips gracefully (no throw) when getMcpServerConfig rejects', async () => {
    // Arrange — a transient McpServerConfig read failure must NOT propagate out
    // of enforceRetentionPolicies (which would mask the prunes that already ran).
    vi.mocked(getMcpServerConfig).mockRejectedValue(new Error('db down'));

    // Act
    const result = await pruneMcpAuditLogs();

    // Assert — swallowed and treated as skip; deleteMany never called
    expect(result).toEqual({ deleted: 0 });
    expect(prisma.mcpAuditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('skips when explicit maxAgeDays <= 0', async () => {
    // Arrange — explicit override with 0
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 0 });

    // Act
    const result = await pruneMcpAuditLogs(0);

    // Assert — getMcpServerConfig not consulted when explicit arg provided and <= 0
    expect(result).toEqual({ deleted: 0 });
    expect(prisma.mcpAuditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('uses explicit maxAgeDays arg and does not call getMcpServerConfig', async () => {
    // Arrange
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 9 });

    // Act
    const result = await pruneMcpAuditLogs(14);

    // Assert — config not consulted when explicit arg provided
    expect(getMcpServerConfig).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 9 });
  });

  it('passes a cutoff date approximately now minus maxAgeDays', async () => {
    // Arrange
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 0 });
    const beforeMs = Date.now();

    // Act
    await pruneMcpAuditLogs(30);

    const afterMs = Date.now();
    const call = vi.mocked(prisma.mcpAuditLog.deleteMany).mock.calls[0][0];
    const cutoff = (call?.where as Record<string, { lt: Date }>).createdAt.lt;
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(beforeMs - expectedMs - 100);
    expect(cutoff.getTime()).toBeLessThanOrEqual(afterMs - expectedMs + 100);
  });
});

// ─── Retention coherence warning (#456) ─────────────────────────────────────

describe('retention coherence warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWebhookDelivery.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEventHookDelivery.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiCostLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiAdminAuditLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiWorkflowExecution.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEvaluationSession.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiEvaluationRun.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      isEnabled: false,
      serverName: 'Test MCP Server',
      serverVersion: '1.0.0',
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 90,
    });
  });

  it('warns when cost logs are pruned before the executions that reference them', async () => {
    // The settings route rejects this pair at write time, but installs
    // configured before that check stay in it silently — nobody re-saves
    // settings to find out. The sweep is the only place that notices.
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      costLogRetentionDays: 30,
      executionRetentionDays: 90,
    } as never);

    await enforceRetentionPolicies();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Retention windows are incoherent'),
      // `orgId: null` is this sweep running outside any tenant context; the
      // per-org case is in the effective-windows suite.
      { orgId: null, costLogRetentionDays: 30, executionRetentionDays: 90 }
    );
  });

  it('stays quiet when cost logs outlive executions', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      costLogRetentionDays: 365,
      executionRetentionDays: 90,
    } as never);

    await enforceRetentionPolicies();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays quiet when the two windows are equal', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      costLogRetentionDays: 90,
      executionRetentionDays: 90,
    } as never);

    await enforceRetentionPolicies();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays quiet when execution retention is unset (executions are never pruned)', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      costLogRetentionDays: 7,
      executionRetentionDays: null,
    } as never);

    await enforceRetentionPolicies();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not fail the sweep when the settings read throws', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue(
      new Error('db unavailable')
    );

    await expect(enforceRetentionPolicies()).resolves.toBeDefined();
  });
});
