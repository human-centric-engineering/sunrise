/**
 * Tests for cost calculation, AiCostLog writes, and budget enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelInfo } from '@/lib/orchestration/llm/types';
import { forgetSpendCaps } from '@/lib/orchestration/llm/spend-caps';

// `after()` records what it was handed (t-903); the real one throws outside a
// request scope.
const mockAfter = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mockAfter,
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCostLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    aiAgent: {
      findUnique: vi.fn(),
      // `touchAgentLastActive` is called from `logCost` after a successful
      // cost-log create. Mocked here so the fire-and-forget bump does not
      // trip on undefined inside these tests.
      update: vi.fn().mockResolvedValue({}),
    },
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Model registry — use real implementations by default so existing calculateCost
// tests continue to use the static fallback map. getAvailableModels is also
// wrapped in a vi.fn() so the calculateLocalSavings "no non-local ref" test can
// temporarily override it per-test.
vi.mock('@/lib/orchestration/llm/model-registry', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orchestration/llm/model-registry')>(
    '@/lib/orchestration/llm/model-registry'
  );
  return {
    ...actual,
    getAvailableModels: vi.fn(actual.getAvailableModels),
    getModel: vi.fn(actual.getModel),
  };
});

const { prisma } = await import('@/lib/db/client');
const {
  getAvailableModels,
  getModel,
  registerModels,
  __resetForTests: resetRegistry,
} = await import('@/lib/orchestration/llm/model-registry');
const {
  calculateCost,
  calculateEmbeddingCost,
  logCost,
  checkBudget,
  getAgentCosts,
  getMonthToDateGlobalSpend,
  calculateLocalSavings,
} = await import('@/lib/orchestration/llm/cost-tracker');

beforeEach(() => {
  // The month-to-date totals are cached across calls; each test starts cold.
  forgetSpendCaps();
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
    // test-review:accept tobe_true — structural assertion on isLocal boolean field of CostResult
    expect(cost.isLocal).toBe(true);
  });

  it('returns $0 and warns for unknown models, NOT flagged isLocal', async () => {
    // "Rate unknown" is NOT "local" — an unmapped cloud model id (e.g.
    // a new gpt-5 variant before the registry catches up) must not be
    // tagged isLocal=true, or the `calculateLocalSavings` report shows
    // phantom savings. Mirrors the same invariant on `calculateEmbeddingCost`.
    const { logger } = await import('@/lib/logging');
    const cost = calculateCost('model-that-does-not-exist', 1_000, 1_000);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.isLocal).toBe(false);
    expect(cost.unpriced).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// #813: a turn nobody could price was stored at $0 exactly like a free one.
describe('calculateCost / logCost — unpriced turns (#813)', () => {
  function entry(overrides: Partial<ModelInfo>): ModelInfo {
    return {
      id: 'matrix-only-model',
      name: 'Matrix only',
      provider: 'acme',
      tier: 'mid',
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      maxContext: 32_000,
      supportsTools: true,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetRegistry();
    vi.mocked(prisma.aiCostLog.create).mockResolvedValue({} as never);
  });

  it('marks a model registered from a null-cost matrix row as unpriced, and says so', async () => {
    const { logger } = await import('@/lib/logging');
    registerModels([entry({ pricingUnknown: true })]);

    const cost = calculateCost('matrix-only-model', 1_000, 1_000);

    expect(cost).toEqual({
      inputCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
      isLocal: false,
      unpriced: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Cost calculation: model has no price, treating as zero cost',
      { model: 'matrix-only-model' }
    );
  });

  it('does not mark a genuinely free model (rates 0, no flag) as unpriced', () => {
    registerModels([entry({})]);
    const cost = calculateCost('matrix-only-model', 1_000, 1_000);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost).not.toHaveProperty('unpriced');
  });

  it('stamps pricing: unknown on the cost row for an unpriced turn', async () => {
    registerModels([entry({ pricingUnknown: true })]);

    await logCost({
      model: 'matrix-only-model',
      provider: 'acme',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'chat',
      metadata: { purpose: 'chat' },
    });

    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0][0].data;
    expect(data.totalCostUsd).toBe(0);
    // Caller metadata survives alongside the marker.
    expect(data.metadata).toEqual({ purpose: 'chat', pricing: 'unknown' });
  });

  it('stamps pricing: unknown for a model the registry has never heard of', async () => {
    await logCost({
      model: 'model-that-does-not-exist',
      provider: 'acme',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'chat',
    });
    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0][0].data;
    expect(data.metadata).toEqual({ pricing: 'unknown' });
  });

  it('does not mark a local turn unpriced, even for a model the registry lacks', async () => {
    await logCost({
      model: 'ollama-model-the-registry-lacks',
      provider: 'ollama',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'chat',
      isLocal: true,
    });
    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0][0].data;
    expect(data.isLocal).toBe(true);
    expect(data.metadata).toBeUndefined();
  });

  it('leaves a priced turn and a free turn without the marker', async () => {
    registerModels([entry({})]);
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'chat',
    });
    await logCost({
      model: 'matrix-only-model',
      provider: 'acme',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'chat',
    });
    const [priced, free] = vi.mocked(prisma.aiCostLog.create).mock.calls.map(([a]) => a.data);
    expect(priced.totalCostUsd).toBeGreaterThan(0);
    expect(priced.metadata).toBeUndefined();
    expect(free.metadata).toBeUndefined();
  });
});

describe('calculateEmbeddingCost — rate sources (t-775)', () => {
  function embeddingEntry(overrides: Partial<ModelInfo>): ModelInfo {
    return {
      id: 'mistral-embed',
      name: 'Mistral Embed',
      provider: 'mistral',
      tier: 'budget',
      inputCostPerMillion: 0.1,
      outputCostPerMillion: 0.1,
      maxContext: 8_000,
      supportsTools: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetRegistry();
    vi.mocked(prisma.aiCostLog.create).mockResolvedValue({} as never);
  });

  it('prices a model the built-in table lacks from its Model Matrix rate', () => {
    registerModels([embeddingEntry({})]);

    const cost = calculateEmbeddingCost('mistral-embed', 2_000_000);

    // 2M tokens × $0.10 / 1M
    expect(cost.totalCostUsd).toBeCloseTo(0.2, 10);
    expect(cost.inputCostUsd).toBeCloseTo(0.2, 10);
    expect(cost.outputCostUsd).toBe(0);
    expect(cost).not.toHaveProperty('unpriced');
  });

  it('prices a model the table names from the table, not the registry', () => {
    // A registry rate that disagrees with the table's list price loses.
    registerModels([embeddingEntry({ id: 'text-embedding-3-small', inputCostPerMillion: 9 })]);

    const cost = calculateEmbeddingCost('text-embedding-3-small', 1_000_000);

    expect(cost.totalCostUsd).toBeCloseTo(0.02, 10);
  });

  it.each([
    ['in neither the table nor the registry', null],
    ['registered from a matrix row with no cost', embeddingEntry({ pricingUnknown: true })],
  ])('marks a model %s as unpriced', (_label, registered) => {
    if (registered) registerModels([registered]);

    const cost = calculateEmbeddingCost('mistral-embed', 1_000);

    expect(cost).toEqual({
      inputCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
      isLocal: false,
      unpriced: true,
    });
  });

  it('treats a local-tier registry model as local and free, even with no cost', () => {
    registerModels([
      embeddingEntry({ id: 'nomic-embed-text', tier: 'local', pricingUnknown: true }),
    ]);

    const cost = calculateEmbeddingCost('nomic-embed-text', 1_000);

    expect(cost).toEqual({ inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: true });
  });

  it('stamps pricing: unknown on an unpriced embedding row', async () => {
    await logCost({
      model: 'embed-model-nobody-priced',
      provider: 'acme',
      inputTokens: 1_000,
      outputTokens: 0,
      operation: 'embedding',
    });

    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0][0].data;
    expect(data.totalCostUsd).toBe(0);
    expect(data.metadata).toEqual({ pricing: 'unknown' });
  });

  it('does not stamp a local provider embedding as unpriced', async () => {
    await logCost({
      model: 'nomic-embed-text',
      provider: 'ollama',
      inputTokens: 1_000,
      outputTokens: 0,
      operation: 'embedding',
      isLocal: true,
    });

    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0][0].data;
    expect(data.isLocal).toBe(true);
    expect(data.metadata).toBeUndefined();
  });
});

describe('logCost', () => {
  it('keeps a write nobody awaits alive past the response (t-903)', async () => {
    mockAfter.mockClear();
    let written!: (value: unknown) => void;
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        written = resolve;
      })
    );

    void logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 5,
      operation: 'chat',
    });

    expect(mockAfter).toHaveBeenCalledTimes(1);
    const handed = mockAfter.mock.calls[0]?.[0] as Promise<unknown>;
    let settled = false;
    void handed.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    written({ id: 'row-1', orgId: null, totalCostUsd: 0, createdAt: new Date() });
    await handed;
    expect(settled).toBe(true);
  });

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

  it("adds the row it wrote to the spend caps' cached totals (§110 t-788)", async () => {
    // Without this, a cap would not see this process's own spend until the
    // cached month-to-date total expired.
    (prisma.aiCostLog.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { totalCostUsd: 10 },
    });
    expect(await getMonthToDateGlobalSpend()).toBe(10);
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'row-1',
      orgId: 'org-a',
      totalCostUsd: 2.5,
      createdAt: new Date(),
    });

    await logCost({
      agentId: 'agent-1',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 500,
      operation: 'chat',
    });

    expect(await getMonthToDateGlobalSpend()).toBe(12.5);
    expect(prisma.aiCostLog.aggregate).toHaveBeenCalledTimes(1);
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
    // test-review:accept tobe_true — structural assertion on isLocal boolean field persisted to DB
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
    // test-review:accept tobe_true — structural assertion on withinBudget boolean field of BudgetStatus
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
  it('treats unknown model as zero-cost, NOT flagged isLocal', async () => {
    // Arrange: a model ID that is not in the registry
    const { logger } = await import('@/lib/logging');
    // Act
    const cost = calculateCost('nonexistent-model-xyz', 100_000, 50_000);
    // Assert: source contract — unknown model is zero-cost, not an error throw
    expect(cost.inputCostUsd).toBe(0);
    expect(cost.outputCostUsd).toBe(0);
    expect(cost.totalCostUsd).toBe(0);
    // "Rate unknown" is NOT "local" — see comment in calculateCost. An
    // unmapped cloud model must not flow into the Local vs. cloud
    // savings report; the local flag is reserved for true local
    // providers (set via `provider.isLocal` on `logCost`).
    expect(cost.isLocal).toBe(false);
    // Assert: the source logs a warning so operators can add the model
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Cost calculation: unknown model, treating as zero cost',
      expect.objectContaining({ model: 'nonexistent-model-xyz' })
    );
  });
});

describe('calculateCost — invalid token counts', () => {
  it('returns zero cost for NaN input tokens', () => {
    const cost = calculateCost('anthropic/claude-sonnet-4-20250514', NaN, 100);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.isLocal).toBe(false);
  });

  it('returns zero cost for NaN output tokens', () => {
    const cost = calculateCost('anthropic/claude-sonnet-4-20250514', 100, NaN);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.isLocal).toBe(false);
  });

  it('returns zero cost for negative input tokens', () => {
    const cost = calculateCost('anthropic/claude-sonnet-4-20250514', -500, 100);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.isLocal).toBe(false);
  });

  it('returns zero cost for Infinity output tokens', () => {
    const cost = calculateCost('anthropic/claude-sonnet-4-20250514', 100, Infinity);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.isLocal).toBe(false);
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
    // test-review:accept tobe_true — structural assertion on globalCapExceeded boolean flag of BudgetStatus
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
    // test-review:accept tobe_true — structural assertion on withinBudget boolean field of BudgetStatus
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
    // test-review:accept tobe_true — structural assertion on withinBudget boolean field of BudgetStatus
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
    // test-review:accept tobe_true — structural assertion on withinBudget boolean field of BudgetStatus
    expect(status.withinBudget).toBe(true);
    expect(status.spent).toBe(20);
    expect(status.limit).toBe(100);
    // Assert: warning logged for the settings lookup failure
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Spend caps: the global cap could not be read, so it is skipped',
      expect.objectContaining({ agentId: 'agent-1', error: 'settings db down' })
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
    // test-review:accept tobe_true — structural assertion on globalCapExceeded boolean flag of BudgetStatus
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

describe('logCost — optional field branches', () => {
  it('includes conversationId when provided', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'chat',
      conversationId: 'conv-1',
    });
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.conversationId).toBe('conv-1');
  });

  it('includes workflowExecutionId when provided', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'tool_call',
      workflowExecutionId: 'wf-exec-1',
    });
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.workflowExecutionId).toBe('wf-exec-1');
  });

  it('includes metadata when provided', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });
    const meta = { traceId: 'abc', retryCount: 2 };
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'chat',
      metadata: meta,
    });
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.metadata).toEqual(meta);
  });

  it('respects explicit isLocal override (true for non-local model)', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'chat',
      isLocal: true,
    });
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // test-review:accept tobe_true — structural assertion on isLocal override
    expect(call.data.isLocal).toBe(true);
  });

  it('omits optional fields from data when not provided', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      operation: 'chat',
    });
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('agentId');
    expect(call.data).not.toHaveProperty('conversationId');
    expect(call.data).not.toHaveProperty('workflowExecutionId');
    expect(call.data).not.toHaveProperty('metadata');
  });
});

describe('getAgentCosts — date range branches', () => {
  it('passes from-only date range filter', async () => {
    (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const from = new Date('2026-04-01T00:00:00Z');

    await getAgentCosts('agent-1', { from });

    const call = (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ gte: from });
  });

  it('passes to-only date range filter', async () => {
    (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const to = new Date('2026-04-30T00:00:00Z');

    await getAgentCosts('agent-1', { to });

    const call = (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ lt: to });
  });

  it('passes both from and to date range filters', async () => {
    (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const from = new Date('2026-04-01T00:00:00Z');
    const to = new Date('2026-04-30T00:00:00Z');

    await getAgentCosts('agent-1', { from, to });

    const call = (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ gte: from, lt: to });
  });

  it('omits createdAt filter when no dateRange is provided', async () => {
    (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await getAgentCosts('agent-1');

    const call = (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where).toEqual({ agentId: 'agent-1' });
  });
});

describe('logCost — user attribution', () => {
  const base = {
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 10,
    outputTokens: 5,
    operation: 'chat' as const,
  };

  const dataOf = () => (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;

  it('writes userId when the caller supplies one', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await logCost({ ...base, userId: 'user-1' });
    expect(dataOf().userId).toBe('user-1');
  });

  it('omits userId entirely for a user-less path rather than writing a falsy FK', async () => {
    // Scheduled and trigger-driven runs, ingestion and embed traffic all reach
    // logCost with no user. `userId` must be ABSENT from the create payload,
    // not present-and-falsy: `''` is not a valid `user.id`, so it would raise
    // P2003 and — since logCost swallows write errors — discard the whole row.
    for (const userless of [null, undefined, '']) {
      (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockClear();
      (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await logCost({ ...base, ...(userless === undefined ? {} : { userId: userless }) });
      expect(dataOf()).not.toHaveProperty('userId');
    }
  });

  it('still writes the row when there is no user — attribution is optional, the cost is not', async () => {
    // The point of the column is durable attribution, not gating: a row with
    // no user is a correct row, and dropping it would lose real spend.
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'r' });
    const row = await logCost({ ...base, userId: null });
    expect(row).toEqual({ id: 'r' });
    expect(dataOf().totalCostUsd).toBeGreaterThan(0);
  });
});

describe('logCost — trace correlation', () => {
  it('omits traceId from the Prisma write when traceId is an empty string', async () => {
    // Arrange: empty string is the sentinel returned by NOOP_SPAN.traceId()
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });

    // Act
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 5,
      operation: 'chat',
      traceId: '',
    });

    // Assert: the if (params.traceId) guard at cost-tracker.ts:148-149 normalises
    // empty strings away so the column remains NULL rather than an empty string.
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('traceId');
  });

  it('includes traceId in the Prisma write when traceId is a real span ID', async () => {
    // Arrange
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });

    // Act
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 5,
      operation: 'chat',
      traceId: 'abc-123',
    });

    // Assert: a non-empty traceId passes through the normalisation guard
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.traceId).toBe('abc-123');
  });

  it('omits spanId from the Prisma write when spanId is an empty string', async () => {
    // Arrange: empty string is the sentinel returned by NOOP_SPAN.spanId()
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });

    // Act
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 5,
      operation: 'chat',
      spanId: '',
    });

    // Assert: empty spanId is normalised away (same guard at cost-tracker.ts:148-149)
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('spanId');
  });

  it('includes spanId in the Prisma write when spanId is a real span ID', async () => {
    // Arrange
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });

    // Act
    await logCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 5,
      operation: 'chat',
      spanId: 'def-456',
    });

    // Assert: a non-empty spanId passes through the normalisation guard
    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.spanId).toBe('def-456');
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

  // Finding 17: the `if (!ref) continue` branch at cost-tracker.ts:381 was uncovered.
  // When getAvailableModels() returns only local-tier models, findCheapestNonLocalInTier
  // returns null for every tier, so ref is null and the row is silently skipped —
  // totalUsd stays 0 and contributing stays 0.
  it('skips rows with no non-local reference and returns zero savings and sampleSize=0', async () => {
    // Arrange: DB returns one local-model row
    const dateFrom = new Date('2024-01-01T00:00:00Z');
    const dateTo = new Date('2024-01-31T23:59:59Z');
    (prisma.aiCostLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { model: 'local:llama-3', inputTokens: 1000, outputTokens: 500 },
    ]);

    // Override getAvailableModels to return only local-tier models —
    // findCheapestNonLocalInTier filters out local, so ref is null for every tier.
    vi.mocked(getAvailableModels).mockReturnValue([
      {
        id: 'local:llama-3',
        name: 'Llama 3',
        tier: 'local',
        provider: 'ollama',
        maxContext: 4096,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        supportsTools: false,
        available: true,
      },
    ]);

    // Act
    const result = await calculateLocalSavings({ dateFrom, dateTo });

    // Assert: row was silently skipped; totalUsd=0, sampleSize=0
    expect(result.usd).toBe(0);
    expect(result.sampleSize).toBe(0);
    expect(result.methodology).toBe('tier_fallback');
  });
});

describe('prompt-cache pricing (t-909)', () => {
  const model = (overrides: Partial<ModelInfo>): ModelInfo => ({
    id: 'priced-model',
    name: 'Priced',
    provider: 'anthropic',
    tier: 'frontier',
    inputCostPerMillion: 10,
    outputCostPerMillion: 50,
    maxContext: 200_000,
    supportsTools: true,
    ...overrides,
  });

  it('prices Claude cache reads at 0.1x and writes at 1.25x when no rate is published', () => {
    vi.mocked(getModel).mockReturnValueOnce(model({}));

    // 1M input: 600k read, 100k written, 300k uncached.
    const cost = calculateCost('priced-model', 1_000_000, 0, {
      cacheReadTokens: 600_000,
      cacheWriteTokens: 100_000,
    });

    // 0.3 × 10 + 0.6 × 1 + 0.1 × 12.5
    expect(cost.inputCostUsd).toBeCloseTo(3 + 0.6 + 1.25);
    expect(cost.totalCostUsd).toBeCloseTo(4.85);
  });

  it("uses the model's own published cache rates over the multipliers", () => {
    vi.mocked(getModel).mockReturnValueOnce(
      model({ cacheReadCostPerMillion: 0.25, cacheWriteCostPerMillion: 12.5 })
    );

    const cost = calculateCost('priced-model', 1_000_000, 0, { cacheReadTokens: 1_000_000 });

    expect(cost.inputCostUsd).toBeCloseTo(0.25);
  });

  it('prices an OpenAI cache hit at the full input rate when no cache rate is published', () => {
    // Its discount varies by model; without a published rate the safe
    // answer is never to price under the real cost.
    vi.mocked(getModel).mockReturnValueOnce(model({ provider: 'openai' }));

    const cost = calculateCost('priced-model', 1_000_000, 0, { cacheReadTokens: 800_000 });

    expect(cost.inputCostUsd).toBeCloseTo(10);
  });

  it('prices an OpenAI cache hit at its published read rate', () => {
    vi.mocked(getModel).mockReturnValueOnce(
      model({ provider: 'openai', inputCostPerMillion: 1.25, cacheReadCostPerMillion: 0.125 })
    );

    const cost = calculateCost('priced-model', 1_000_000, 0, { cacheReadTokens: 800_000 });

    // 0.2 × 1.25 + 0.8 × 0.125
    expect(cost.inputCostUsd).toBeCloseTo(0.35);
  });

  it('never prices more cached input than there was input', () => {
    vi.mocked(getModel).mockReturnValueOnce(model({}));

    const cost = calculateCost('priced-model', 1_000, 0, {
      cacheReadTokens: 900,
      cacheWriteTokens: 5_000,
    });

    // 900 read, the remaining 100 written, none uncached.
    expect(cost.inputCostUsd).toBeCloseTo((900 * 1 + 100 * 12.5) / 1_000_000);
  });

  it('prices input as before when the call reported no cache use', () => {
    vi.mocked(getModel).mockReturnValueOnce(model({}));

    expect(calculateCost('priced-model', 1_000_000, 0).inputCostUsd).toBeCloseTo(10);
  });

  it('writes the cache counts to the cost row and prices them into inputCostUsd', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });
    vi.mocked(getModel).mockReturnValueOnce(model({}));

    await logCost({
      model: 'priced-model',
      provider: 'anthropic',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      operation: 'chat',
    });

    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.cacheReadTokens).toBe(1_000_000);
    expect(call.data).not.toHaveProperty('cacheWriteTokens');
    expect(call.data.inputCostUsd).toBeCloseTo(1);
  });
});

describe('service-tier pricing (t-911)', () => {
  const gpt5: ModelInfo = {
    id: 'tier-model',
    name: 'Tier model',
    provider: 'openai',
    tier: 'frontier',
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10,
    maxContext: 400_000,
    supportsTools: true,
  };

  it.each([
    ['flex', 0.5],
    ['priority', 2],
  ] as const)('prices a %s call at %dx the standard rate, input and output', (serviceTier, x) => {
    vi.mocked(getModel).mockReturnValueOnce(gpt5);
    const cost = calculateCost('tier-model', 1_000_000, 1_000_000, { serviceTier });
    expect(cost.inputCostUsd).toBeCloseTo(1.25 * x);
    expect(cost.outputCostUsd).toBeCloseTo(10 * x);
  });

  it('stamps the tier on the cost row, whose costs include it', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });
    vi.mocked(getModel).mockReturnValueOnce(gpt5);

    await logCost({
      model: 'tier-model',
      provider: 'openai',
      inputTokens: 1_000_000,
      outputTokens: 0,
      serviceTier: 'flex',
      operation: 'chat',
    });

    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.metadata).toEqual({ serviceTier: 'flex' });
    expect(call.data.inputCostUsd).toBeCloseTo(0.625);
  });
});

describe('web search pricing (t-912)', () => {
  const sonnet: ModelInfo = {
    id: 'search-model',
    name: 'Search model',
    provider: 'anthropic',
    tier: 'mid',
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    maxContext: 200_000,
    supportsTools: true,
  };

  it('adds $0.01 a search to the total, outside the input and output costs', () => {
    vi.mocked(getModel).mockReturnValueOnce(sonnet);
    const cost = calculateCost('search-model', 1_000_000, 0, { webSearchRequests: 3 });
    expect(cost.inputCostUsd).toBeCloseTo(3);
    expect(cost.outputCostUsd).toBe(0);
    expect(cost.webSearchCostUsd).toBeCloseTo(0.03);
    expect(cost.totalCostUsd).toBeCloseTo(3.03);
  });

  it('still charges the searches when the model has no token price', () => {
    vi.mocked(getModel).mockReturnValueOnce(undefined);
    const cost = calculateCost('unknown-model', 1000, 1000, { webSearchRequests: 2 });
    expect(cost.unpriced).toBe(true);
    expect(cost.totalCostUsd).toBeCloseTo(0.02);
  });

  it('leaves a call without searches as it was', () => {
    vi.mocked(getModel).mockReturnValueOnce(sonnet);
    const cost = calculateCost('search-model', 1_000_000, 0, { webSearchRequests: 0 });
    expect(cost).not.toHaveProperty('webSearchCostUsd');
    expect(cost.totalCostUsd).toBeCloseTo(3);
  });

  it('records the searches and their cost on the row, whose total includes them', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });
    vi.mocked(getModel).mockReturnValueOnce(sonnet);

    await logCost({
      model: 'search-model',
      provider: 'anthropic',
      inputTokens: 1_000_000,
      outputTokens: 0,
      webSearchRequests: 4,
      operation: 'chat',
    });

    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.metadata).toEqual({ webSearchRequests: 4, webSearchCostUsd: 0.04 });
    expect(call.data.inputCostUsd).toBeCloseTo(3);
    expect(call.data.totalCostUsd).toBeCloseTo(3.04);
  });
});

describe('code execution pricing (t-956)', () => {
  const sonnet: ModelInfo = {
    id: 'code-model',
    name: 'Code model',
    provider: 'anthropic',
    tier: 'mid',
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    maxContext: 200_000,
    supportsTools: true,
  };
  // 1800 s at $0.10/h = $0.05
  const codeExecution = { runs: 2, billedSeconds: 1800, usdPerHour: 0.1 };

  it('adds billedSeconds/3600 x usdPerHour to the total, outside the token costs', () => {
    vi.mocked(getModel).mockReturnValueOnce(sonnet);
    const cost = calculateCost('code-model', 1_000_000, 0, { codeExecution });
    expect(cost.inputCostUsd).toBeCloseTo(3);
    expect(cost.codeExecutionCostUsd).toBeCloseTo(0.05);
    expect(cost.totalCostUsd).toBeCloseTo(3.05);
    expect(cost).not.toHaveProperty('webSearchCostUsd');
  });

  it('adds it beside web search, each reported on its own', () => {
    vi.mocked(getModel).mockReturnValueOnce(sonnet);
    const cost = calculateCost('code-model', 1_000_000, 0, { codeExecution, webSearchRequests: 3 });
    expect(cost.webSearchCostUsd).toBeCloseTo(0.03);
    expect(cost.codeExecutionCostUsd).toBeCloseTo(0.05);
    expect(cost.totalCostUsd).toBeCloseTo(3.08);
  });

  it('still charges the runs when the model has no token price', () => {
    vi.mocked(getModel).mockReturnValueOnce(undefined);
    const cost = calculateCost('unknown-model', 1000, 1000, { codeExecution });
    expect(cost.unpriced).toBe(true);
    expect(cost.codeExecutionCostUsd).toBeCloseTo(0.05);
    expect(cost.totalCostUsd).toBeCloseTo(0.05);
  });

  it('leaves a call with no billed seconds as it was', () => {
    vi.mocked(getModel).mockReturnValueOnce(sonnet);
    const cost = calculateCost('code-model', 1_000_000, 0, {
      codeExecution: { runs: 1, billedSeconds: 0, usdPerHour: 0.1 },
    });
    expect(cost).not.toHaveProperty('codeExecutionCostUsd');
    expect(cost.totalCostUsd).toBeCloseTo(3);
  });

  it('records runs, billed seconds and cost on the row, whose total includes them', async () => {
    (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'row-1' });
    vi.mocked(getModel).mockReturnValueOnce(sonnet);

    await logCost({
      model: 'code-model',
      provider: 'anthropic',
      inputTokens: 1_000_000,
      outputTokens: 0,
      codeExecution,
      operation: 'chat',
    });

    const call = (prisma.aiCostLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.metadata).toEqual({
      codeExecutionRuns: 2,
      codeExecutionBilledSeconds: 1800,
      codeExecutionCostUsd: expect.closeTo(0.05, 10),
    });
    expect(call.data.totalCostUsd).toBeCloseTo(3.05);
  });
});
