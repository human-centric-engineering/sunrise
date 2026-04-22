/**
 * Tests for cost calculation, AiCostLog writes, and budget enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCostLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    aiAgent: {
      findUnique: vi.fn(),
    },
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const {
  calculateCost,
  logCost,
  checkBudget,
  getAgentCosts,
  getMonthToDateGlobalSpend,
  calculateLocalSavings,
} = await import('@/lib/orchestration/llm/cost-tracker');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('calculateCost', () => {
  it('computes cost for Sonnet-4.6 pricing ($3/M in, $15/M out)', () => {
    const cost = calculateCost('claude-sonnet-4-6', 1_000_000, 500_000);
    expect(cost.inputCostUsd).toBeCloseTo(3);
    expect(cost.outputCostUsd).toBeCloseTo(7.5);
    expect(cost.totalCostUsd).toBeCloseTo(10.5);
    expect(cost.isLocal).toBe(false);
  });

  it('scales linearly for small token counts', () => {
    const cost = calculateCost('claude-haiku-4-5', 1_000, 1_000);
    // $1/M in, $5/M out
    expect(cost.inputCostUsd).toBeCloseTo(0.001);
    expect(cost.outputCostUsd).toBeCloseTo(0.005);
  });

  it('returns $0 for local-tier models', () => {
    const cost = calculateCost('local:generic', 10_000, 10_000);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.isLocal).toBe(true);
  });

  it('returns $0 and warns for unknown models', async () => {
    const { logger } = await import('@/lib/logging');
    const cost = calculateCost('model-that-does-not-exist', 1_000, 1_000);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.isLocal).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('logCost', () => {
  it('persists a row with computed costs and returns it', async () => {
    const created = { id: 'row-1' };
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const row = await logCost({
      agentId: 'agent-1',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 500,
      operation: 'chat',
    });

    expect(row).toBe(created);
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.agentId).toBe('agent-1');
    expect(call.data.model).toBe('claude-sonnet-4-6');
    expect(call.data.inputCostUsd).toBeCloseTo(0.003);
    expect(call.data.outputCostUsd).toBeCloseTo(0.0075);
    expect(call.data.isLocal).toBe(false);
    expect(call.data.operation).toBe('chat');
  });

  it('returns null instead of throwing on DB failure', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('db exploded')
    );
    const row = await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 5,
      operation: 'chat',
    });
    expect(row).toBeNull();
  });

  it('forces isLocal=true for local models', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await logCost({
      model: 'local:generic',
      provider: 'local',
      inputTokens: 100,
      outputTokens: 100,
      operation: 'chat',
    });
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.isLocal).toBe(true);
    expect(call.data.totalCostUsd).toBe(0);
  });
});

describe('checkBudget', () => {
  it('returns withinBudget=true with null limit when agent has no budget', async () => {
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyBudgetUsd: null,
    });
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { totalCostUsd: 5 },
    });
    const status = await checkBudget('agent-1');
    expect(status).toEqual({
      withinBudget: true,
      spent: 5,
      limit: null,
      remaining: null,
    });
  });

  it('returns withinBudget=true when spend is under limit', async () => {
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyBudgetUsd: 100,
    });
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { totalCostUsd: 42 },
    });
    const status = await checkBudget('agent-1');
    expect(status.withinBudget).toBe(true);
    expect(status.spent).toBe(42);
    expect(status.limit).toBe(100);
    expect(status.remaining).toBe(58);
  });

  it('returns withinBudget=false when spend exceeds limit', async () => {
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyBudgetUsd: 50,
    });
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { totalCostUsd: 75 },
    });
    const status = await checkBudget('agent-1');
    expect(status.withinBudget).toBe(false);
    expect(status.remaining).toBe(-25);
  });

  it('throws when agent does not exist', async () => {
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(checkBudget('missing')).rejects.toThrow(/not found/);
  });
});

describe('getAgentCosts', () => {
  it('aggregates totals and breakdowns', async () => {
    (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        operation: 'chat',
        inputTokens: 100,
        outputTokens: 50,
        totalCostUsd: 0.5,
      },
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        operation: 'tool_call',
        inputTokens: 20,
        outputTokens: 10,
        totalCostUsd: 0.1,
      },
    ]);

    const summary = await getAgentCosts('agent-1');
    expect(summary.totalCostUsd).toBeCloseTo(0.6);
    expect(summary.totalInputTokens).toBe(120);
    expect(summary.totalOutputTokens).toBe(60);
    expect(summary.byProvider.anthropic).toBeCloseTo(0.6);
    expect(summary.byModel['claude-sonnet-4-6']).toBeCloseTo(0.5);
    expect(summary.byOperation.chat).toBeCloseTo(0.5);
    expect(summary.byOperation.tool_call).toBeCloseTo(0.1);
    expect(summary.entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// New branch-coverage cases (Sprint 3, Batch 3.1)
// ---------------------------------------------------------------------------

describe('calculateCost — zero-token branches', () => {
  it('returns zero costs without NaN when inputTokens is 0', () => {
    // Arrange: zero input tokens, some output tokens
    // Act
    const cost = calculateCost('claude-sonnet-4-6', 0, 500_000);
    // Assert: no NaN or negative values
    expect(cost.inputCostUsd).toBe(0);
    expect(cost.outputCostUsd).toBeCloseTo(7.5);
    expect(cost.totalCostUsd).toBeCloseTo(7.5);
    expect(cost.isLocal).toBe(false);
  });

  it('returns zero costs without NaN when outputTokens is 0', () => {
    // Arrange: some input tokens, zero output tokens
    // Act
    const cost = calculateCost('claude-sonnet-4-6', 1_000_000, 0);
    // Assert: no NaN or negative values
    expect(cost.inputCostUsd).toBeCloseTo(3);
    expect(cost.outputCostUsd).toBe(0);
    expect(cost.totalCostUsd).toBeCloseTo(3);
    expect(cost.isLocal).toBe(false);
  });

  it('returns all-zero costs without NaN when both token counts are 0', () => {
    // Arrange: both token counts zero — should not produce NaN or negative
    // Act
    const cost = calculateCost('claude-haiku-4-5', 0, 0);
    // Assert: every field is exactly 0, not NaN
    expect(cost.inputCostUsd).toBe(0);
    expect(cost.outputCostUsd).toBe(0);
    expect(cost.totalCostUsd).toBe(0);
    expect(Number.isNaN(cost.totalCostUsd)).toBe(false);
    expect(cost.isLocal).toBe(false);
  });
});

describe('calculateCost — unknown model ID', () => {
  it('treats unknown model as zero-cost and flags isLocal=true', async () => {
    // Arrange: a model ID that is not in the registry
    const { logger } = await import('@/lib/logging');
    // Act
    const cost = calculateCost('nonexistent-model-xyz', 100_000, 50_000);
    // Assert: source contract — unknown model is zero-cost, not an error throw
    expect(cost.inputCostUsd).toBe(0);
    expect(cost.outputCostUsd).toBe(0);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.isLocal).toBe(true);
    // Assert: the source logs a warning so operators can add the model
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Cost calculation: unknown model, treating as zero cost',
      expect.objectContaining({ model: 'nonexistent-model-xyz' })
    );
  });
});

describe('checkBudget — global budget cap', () => {
  it('returns globalCapExceeded=true when global spend meets or exceeds the cap', async () => {
    // Arrange: agent has no per-agent budget; global cap is $100 and $100 has been spent
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyBudgetUsd: null,
    });
    // Per-agent spend aggregate
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ _sum: { totalCostUsd: 10 } }) // per-agent month spend
      .mockResolvedValueOnce({ _sum: { totalCostUsd: 100 } }); // global month spend
    (prisma.aiOrchestrationSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      globalMonthlyBudgetUsd: 100,
    });

    // Act
    const status = await checkBudget('agent-1');

    // Assert: global cap reached → withinBudget=false, flag set
    expect(status.withinBudget).toBe(false);
    expect(status.globalCapExceeded).toBe(true);
    expect(status.limit).toBeNull();
    expect(status.remaining).toBeNull();
  });

  it('does not set globalCapExceeded when global spend is below the cap', async () => {
    // Arrange: global cap is $100, only $50 spent globally
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyBudgetUsd: null,
    });
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ _sum: { totalCostUsd: 5 } }) // per-agent
      .mockResolvedValueOnce({ _sum: { totalCostUsd: 50 } }); // global
    (prisma.aiOrchestrationSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      globalMonthlyBudgetUsd: 100,
    });

    // Act
    const status = await checkBudget('agent-1');

    // Assert: under cap → withinBudget=true, no globalCapExceeded flag
    expect(status.withinBudget).toBe(true);
    expect(status.globalCapExceeded).toBeUndefined();
  });

  it('does not set globalCapExceeded when no global cap is configured (null)', async () => {
    // Arrange: settings exist but globalMonthlyBudgetUsd is null
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyBudgetUsd: null,
    });
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { totalCostUsd: 999 },
    });
    (prisma.aiOrchestrationSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      globalMonthlyBudgetUsd: null,
    });

    // Act
    const status = await checkBudget('agent-1');

    // Assert: no cap configured → always within budget (for the global dimension)
    expect(status.withinBudget).toBe(true);
    expect(status.globalCapExceeded).toBeUndefined();
  });

  it('falls back gracefully when aiOrchestrationSettings lookup throws', async () => {
    // Arrange: settings DB lookup throws; per-agent budget is fine
    const { logger } = await import('@/lib/logging');
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyBudgetUsd: 100,
    });
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { totalCostUsd: 20 },
    });
    (prisma.aiOrchestrationSettings.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('settings db down')
    );

    // Act: must not throw; settings failure is swallowed with a warning
    const status = await checkBudget('agent-1');

    // Assert: per-agent budget evaluated normally; global cap treated as unchecked
    expect(status.withinBudget).toBe(true);
    expect(status.spent).toBe(20);
    expect(status.limit).toBe(100);
    // Assert: warning logged for the settings lookup failure
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'checkBudget: global cap lookup failed, falling back to per-agent only',
      expect.objectContaining({ agentId: 'agent-1' })
    );
  });

  it('sets globalCapExceeded=true even when agent has its own per-agent budget', async () => {
    // Arrange: agent has a $50 per-agent budget with only $10 spent,
    // but the global $100 cap has been reached (globalSpent=$100)
    (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      monthlyBudgetUsd: 50,
    });
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ _sum: { totalCostUsd: 10 } }) // per-agent month spend
      .mockResolvedValueOnce({ _sum: { totalCostUsd: 100 } }); // global month spend
    (prisma.aiOrchestrationSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      globalMonthlyBudgetUsd: 100,
    });

    // Act
    const status = await checkBudget('agent-1');

    // Assert: withinBudget=false because global cap exceeded, even though per-agent is fine
    expect(status.withinBudget).toBe(false);
    expect(status.globalCapExceeded).toBe(true);
    expect(status.limit).toBe(50);
    expect(status.remaining).toBe(40); // 50 - 10
  });
});

describe('getMonthToDateGlobalSpend', () => {
  it('returns the sum from the aggregate query', async () => {
    // Arrange
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { totalCostUsd: 123.45 },
    });
    // Act
    const result = await getMonthToDateGlobalSpend();
    // Assert: returns the aggregated value, not 0 or NaN
    expect(result).toBeCloseTo(123.45);
  });

  it('returns 0 when aggregate sum is null (no rows in period)', async () => {
    // Arrange: no cost rows for this month
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { totalCostUsd: null },
    });
    // Act
    const result = await getMonthToDateGlobalSpend();
    // Assert: null coalesced to 0
    expect(result).toBe(0);
  });
});

describe('calculateLocalSavings', () => {
  it('returns zero savings when no local rows exist in the window', async () => {
    // Arrange: DB returns empty list for local rows
    (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const dateFrom = new Date('2024-01-01T00:00:00Z');
    const dateTo = new Date('2024-01-31T23:59:59Z');

    // Act
    const result = await calculateLocalSavings({ dateFrom, dateTo });

    // Assert: zero savings but valid shape returned
    expect(result.usd).toBe(0);
    expect(result.sampleSize).toBe(0);
    expect(result.methodology).toBe('tier_fallback');
    expect(result.dateFrom).toBe(dateFrom.toISOString());
    expect(result.dateTo).toBe(dateTo.toISOString());
  });

  it('returns zero savings and logs a warning when the DB query throws', async () => {
    // Arrange: DB throws — source contract is to catch and return zero savings
    const { logger } = await import('@/lib/logging');
    (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('db timeout')
    );
    const dateFrom = new Date('2024-01-01T00:00:00Z');
    const dateTo = new Date('2024-01-31T23:59:59Z');

    // Act: must not throw
    const result = await calculateLocalSavings({ dateFrom, dateTo });

    // Assert: zero savings returned gracefully
    expect(result.usd).toBe(0);
    expect(result.sampleSize).toBe(0);
    // Assert: warning logged
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'calculateLocalSavings: query failed, returning zero savings',
      expect.objectContaining({ error: 'db timeout' })
    );
  });
});
