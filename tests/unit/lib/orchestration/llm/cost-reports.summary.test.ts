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

const mockedAggregate = prisma.aiCostLog.aggregate as unknown as ReturnType<typeof vi.fn>;
const mockedGroupBy = prisma.aiCostLog.groupBy as unknown as ReturnType<typeof vi.fn>;
const mockedAgentFind = prisma.aiAgent.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedRaw = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;
const mockedCalcLocalSavings = calculateLocalSavings as unknown as ReturnType<typeof vi.fn>;

function setupDefaultMocks() {
  // Today, week, month aggregates
  mockedAggregate
    .mockResolvedValueOnce({ _sum: { totalCostUsd: 1 } })
    .mockResolvedValueOnce({ _sum: { totalCostUsd: 5 } })
    .mockResolvedValueOnce({ _sum: { totalCostUsd: 20 } });
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
