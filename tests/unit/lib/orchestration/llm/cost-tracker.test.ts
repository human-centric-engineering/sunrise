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
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { calculateCost, logCost, checkBudget, getAgentCosts } =
  await import('@/lib/orchestration/llm/cost-tracker');

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
