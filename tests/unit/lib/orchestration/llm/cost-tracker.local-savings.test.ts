/**
 * Unit tests for calculateLocalSavings() in cost-tracker.ts
 *
 * Test coverage:
 * - Tier fallback path (the only production path — local rows have local
 *   model ids, so every row falls back to the cheapest non-local model
 *   in the same tier).
 * - Unknown model ids default to the `budget` tier.
 * - Methodology is always `tier_fallback` when any row contributes.
 * - Empty `findMany` result returns the zero base.
 * - DB errors are swallowed — the caller receives a zero-savings result.
 *
 * @see lib/orchestration/llm/cost-tracker.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCostLog: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
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
const { calculateLocalSavings } = await import('@/lib/orchestration/llm/cost-tracker');

const mockedFindMany = prisma.aiCostLog.findMany as unknown as ReturnType<typeof vi.fn>;

const DATE_FROM = new Date('2026-04-01T00:00:00.000Z');
const DATE_TO = new Date('2026-04-30T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('calculateLocalSavings', () => {
  describe('tier fallback (the only production path)', () => {
    it('prices every local row against cheapest-non-local-in-tier and reports tier_fallback', async () => {
      // Arrange: two local rows plus one unknown-to-the-registry row.
      mockedFindMany.mockResolvedValueOnce([
        { model: 'local:generic', inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { model: 'completely-unknown-xyz', inputTokens: 100_000, outputTokens: 50_000 },
      ]);

      // Act
      const result = await calculateLocalSavings({ dateFrom: DATE_FROM, dateTo: DATE_TO });

      // Assert
      expect(result.methodology).toBe('tier_fallback');
      expect(result.sampleSize).toBe(2);
      expect(result.usd).toBeGreaterThan(0);
      expect(result.dateFrom).toBe(DATE_FROM.toISOString());
      expect(result.dateTo).toBe(DATE_TO.toISOString());

      // Verify DB was queried with correct params
      expect(mockedFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isLocal: true }),
          select: { model: true, inputTokens: true, outputTokens: true },
        })
      );
    });

    it('returns tier_fallback methodology even for a single row', async () => {
      mockedFindMany.mockResolvedValueOnce([
        { model: 'local:generic', inputTokens: 1_000_000, outputTokens: 500_000 },
      ]);

      const result = await calculateLocalSavings({ dateFrom: DATE_FROM, dateTo: DATE_TO });

      expect(result.methodology).toBe('tier_fallback');
      expect(result.sampleSize).toBe(1);
      expect(result.usd).toBeGreaterThan(0);
    });
  });

  describe('empty rows', () => {
    it('returns base result with usd=0 and sampleSize=0 when no local rows found', async () => {
      mockedFindMany.mockResolvedValueOnce([]);

      const result = await calculateLocalSavings({ dateFrom: DATE_FROM, dateTo: DATE_TO });

      expect(result.usd).toBe(0);
      expect(result.sampleSize).toBe(0);
      expect(result.methodology).toBe('tier_fallback');
      expect(result.dateFrom).toBe(DATE_FROM.toISOString());
      expect(result.dateTo).toBe(DATE_TO.toISOString());
    });
  });

  describe('DB query failure', () => {
    it('returns zero-savings base result and does not throw when findMany rejects', async () => {
      mockedFindMany.mockRejectedValueOnce(new Error('DB connection failed'));

      let thrown = false;
      let result;
      try {
        result = await calculateLocalSavings({ dateFrom: DATE_FROM, dateTo: DATE_TO });
      } catch {
        thrown = true;
      }

      expect(thrown).toBe(false);
      expect(result?.usd).toBe(0);
      expect(result?.sampleSize).toBe(0);
      expect(result?.methodology).toBe('tier_fallback');
    });
  });
});
