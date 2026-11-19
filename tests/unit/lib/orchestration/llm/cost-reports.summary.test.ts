/**
 * Unit tests for getCostSummary localSavings passthrough in cost-reports.ts
 *
 * Test Coverage:
 * - calculateLocalSavings returns a valid result → summary includes it verbatim
 * - calculateLocalSavings throws → summary returns localSavings: null (catch branch at lines 353-356)
 *   and does NOT re-throw
 *
 * @see lib/orchestration/llm/cost-reports.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB first
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCostLog: {
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    aiAgent: {
      findMany: vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock cost-tracker to control calculateLocalSavings
vi.mock('@/lib/orchestration/llm/cost-tracker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestration/llm/cost-tracker')>();
  return {
    ...actual,
    calculateLocalSavings: vi.fn(),
  };
});

const { prisma } = await import('@/lib/db/client');
const { calculateLocalSavings } = await import('@/lib/orchestration/llm/cost-tracker');
const { getCostSummary } = await import('@/lib/orchestration/llm/cost-reports');

const mockedGroupBy = prisma.aiCostLog.groupBy as unknown as ReturnType<typeof vi.fn>;
const mockedAgentFind = prisma.aiAgent.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedRaw = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;
const mockedCalcLocalSavings = calculateLocalSavings as unknown as ReturnType<typeof vi.fn>;

function setupDefaultMocks() {
  // Today, week and month, then byAgent and byModel
  // Today, week and month, each grouped by ownKey (§137).
  mockedGroupBy
    .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 1 } }])
    .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 5 } }])
    .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 20 } }]);
  // byAgent groupBy, byModel groupBy
  mockedGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  // trend raw
  mockedRaw.mockResolvedValueOnce([]);
  // agents findMany
  mockedAgentFind.mockResolvedValueOnce([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCostSummary — localSavings passthrough', () => {
  it('includes localSavings verbatim when calculateLocalSavings returns a valid result', async () => {
    // Arrange
    const mockSavings = {
      usd: 42.5,
      methodology: 'tier_fallback' as const,
      sampleSize: 7,
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2026-04-30T00:00:00.000Z',
    };
    setupDefaultMocks();
    mockedCalcLocalSavings.mockResolvedValueOnce(mockSavings);

    // Act
    const summary = await getCostSummary();

    // Assert
    expect(summary.localSavings).toEqual(mockSavings);
    expect(mockedCalcLocalSavings).toHaveBeenCalledOnce();
  });

  it('returns localSavings: null and does NOT re-throw when calculateLocalSavings throws', async () => {
    // Arrange
    setupDefaultMocks();
    mockedCalcLocalSavings.mockRejectedValueOnce(new Error('savings calculation exploded'));

    // Act
    let thrown = false;
    let summary;
    try {
      summary = await getCostSummary();
    } catch {
      thrown = true;
    }

    // Assert: catch branch at lines 353-356 captures the error
    expect(thrown).toBe(false);
    expect(summary?.localSavings).toBeNull();
    // The rest of the summary still renders
    expect(summary?.totals).toBeDefined();
    expect(summary?.byAgent).toBeDefined();
    expect(summary?.trend).toBeDefined();
  });
});

describe('getCostSummary — byModel provider attribution (#436)', () => {
  it('groups by provider as well as model', async () => {
    // Arrange
    setupDefaultMocks();
    mockedCalcLocalSavings.mockResolvedValueOnce(null);

    // Act
    await getCostSummary();

    // Assert — without `provider` in the grouping the UI can only guess which
    // catalogue entry a spend row belongs to, and picks the wrong one for any
    // model id that exists under two providers.
    const groupings = mockedGroupBy.mock.calls.map(([args]) => (args as { by: string[] }).by);
    const byModel = groupings.find((by) => by.includes('model'));
    // …and by `ownKey`, folded back into the row (§137 t-1058).
    expect(byModel).toEqual(['model', 'provider', 'ownKey']);
  });

  it('keeps the same model id under two providers as separate rows', async () => {
    // Arrange — the exact shape behind the bug: gpt-4o served by OpenAI, and a
    // second catalogue provider carrying the same id.
    // Today, week and month, each grouped by ownKey (§137).
    mockedGroupBy
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 1 } }])
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 5 } }])
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 20 } }]);
    mockedGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { model: 'gpt-4o', provider: 'openai', _sum: { totalCostUsd: 1.9 } },
      { model: 'gpt-4o', provider: 'microsoft', _sum: { totalCostUsd: 0.4 } },
    ]);
    mockedRaw.mockResolvedValueOnce([]);
    mockedAgentFind.mockResolvedValueOnce([]);
    mockedCalcLocalSavings.mockResolvedValueOnce(null);

    // Act
    const summary = await getCostSummary();

    // Assert — two rows, each carrying the provider that served it, sorted by spend
    expect(summary.byModel).toEqual([
      { model: 'gpt-4o', provider: 'openai', monthSpend: 1.9, ownKeyMonthSpend: 0 },
      { model: 'gpt-4o', provider: 'microsoft', monthSpend: 0.4, ownKeyMonthSpend: 0 },
    ]);
  });
});

describe('getCostSummary — spend on orgs’ own keys in the trend and byModel (§137 t-1058)', () => {
  it('folds a model’s own-key and platform halves into one row that says how much was on own keys', async () => {
    mockedGroupBy
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 1 } }])
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 5 } }])
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 20 } }]);
    mockedGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { model: 'gpt-4o', provider: 'openai', ownKey: false, _sum: { totalCostUsd: 2 } },
      { model: 'claude', provider: 'anthropic', ownKey: true, _sum: { totalCostUsd: 4 } },
      { model: 'gpt-4o', provider: 'openai', ownKey: true, _sum: { totalCostUsd: 3 } },
      { model: 'gpt-4o', provider: 'microsoft', ownKey: false, _sum: { totalCostUsd: null } },
    ]);
    mockedRaw.mockResolvedValueOnce([]);
    mockedAgentFind.mockResolvedValueOnce([]);
    mockedCalcLocalSavings.mockResolvedValueOnce(null);

    const summary = await getCostSummary();

    // One row per provider and model, sorted by all spend.
    expect(summary.byModel).toEqual([
      { model: 'gpt-4o', provider: 'openai', monthSpend: 5, ownKeyMonthSpend: 3 },
      { model: 'claude', provider: 'anthropic', monthSpend: 4, ownKeyMonthSpend: 4 },
      { model: 'gpt-4o', provider: 'microsoft', monthSpend: 0, ownKeyMonthSpend: 0 },
    ]);
  });

  it('gives each trend point the part of its day on orgs’ own keys, summed by the query', async () => {
    setupDefaultMocks();
    mockedRaw.mockReset();
    mockedRaw.mockResolvedValueOnce([
      { day: new Date('2026-11-18T00:00:00Z'), total_cost_usd: '60', own_key_cost_usd: '50' },
      { day: new Date('2026-11-19T00:00:00Z'), total_cost_usd: 3, own_key_cost_usd: 0 },
    ]);
    mockedCalcLocalSavings.mockResolvedValueOnce(null);

    const summary = await getCostSummary();

    expect(summary.trend).toEqual([
      { date: '2026-11-18', totalCostUsd: 60, ownKeyCostUsd: 50 },
      { date: '2026-11-19', totalCostUsd: 3, ownKeyCostUsd: 0 },
    ]);
    const [sql] = mockedRaw.mock.calls[0] as [string];
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'SUM(CASE WHEN "ownKey" THEN "totalCostUsd" ELSE 0 END) AS own_key_cost_usd'
    );
  });
});
