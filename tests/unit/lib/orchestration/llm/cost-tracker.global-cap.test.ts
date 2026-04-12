/**
 * Unit tests for global-cap branch in checkBudget() in cost-tracker.ts
 *
 * Test Coverage:
 * - globalMonthlyBudgetUsd null → no globalCapExceeded
 * - cap set, MTD spend below cap → withinBudget: true
 * - cap set, MTD spend at/above cap → withinBudget: false, globalCapExceeded: true
 * - per-agent budget interacts correctly with global cap
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
const { checkBudget } = await import('@/lib/orchestration/llm/cost-tracker');

const mockedAgentFindUnique = prisma.aiAgent.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedAggregate = prisma.aiCostLog.aggregate as unknown as ReturnType<typeof vi.fn>;
const mockedSettingsFindUnique = prisma.aiOrchestrationSettings.findUnique as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkBudget — global cap', () => {
  describe('when globalMonthlyBudgetUsd is null (no global cap set)', () => {
    it('does not set globalCapExceeded even with high agent spend', async () => {
      // Arrange
      mockedAgentFindUnique.mockResolvedValueOnce({ monthlyBudgetUsd: null });
      // Per-agent aggregate
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 9999 } });
      // Settings: no global cap
      mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: null });

      // Act
      const status = await checkBudget('agent-1');

      // Assert: withinBudget true (no per-agent budget), no globalCapExceeded flag
      expect(status.withinBudget).toBe(true);
      expect(status.globalCapExceeded).toBeUndefined();
    });
  });

  describe('when globalMonthlyBudgetUsd is set and MTD global spend is below cap', () => {
    it('returns withinBudget: true with no globalCapExceeded', async () => {
      // Arrange: global cap = $1000, MTD global spend = $500
      mockedAgentFindUnique.mockResolvedValueOnce({ monthlyBudgetUsd: null });
      // Per-agent aggregate (first call in checkBudget)
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 200 } });
      // Settings findUnique for global cap
      mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: 1000 });
      // getMonthToDateGlobalSpend aggregate (second aggregate call)
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 500 } });

      // Act
      const status = await checkBudget('agent-1');

      // Assert
      expect(status.withinBudget).toBe(true);
      expect(status.globalCapExceeded).toBeUndefined();
      expect(status.spent).toBe(200);
    });
  });

  describe('when globalMonthlyBudgetUsd is set and MTD global spend meets the cap', () => {
    it('returns withinBudget: false and globalCapExceeded: true', async () => {
      // Arrange: global cap = $1000, MTD global spend = $1000 (meets the cap)
      mockedAgentFindUnique.mockResolvedValueOnce({ monthlyBudgetUsd: null });
      // Per-agent aggregate
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 300 } });
      // Settings findUnique
      mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: 1000 });
      // Global MTD spend aggregate
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 1000 } });

      // Act
      const status = await checkBudget('agent-1');

      // Assert: global cap exceeded
      expect(status.withinBudget).toBe(false);
      expect(status.globalCapExceeded).toBe(true);
    });

    it('returns withinBudget: false and globalCapExceeded: true when global spend exceeds cap', async () => {
      // Arrange: global cap = $1000, MTD global spend = $1500 (exceeds cap)
      mockedAgentFindUnique.mockResolvedValueOnce({ monthlyBudgetUsd: null });
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 0 } });
      mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: 1000 });
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 1500 } });

      // Act
      const status = await checkBudget('agent-1');

      // Assert
      expect(status.withinBudget).toBe(false);
      expect(status.globalCapExceeded).toBe(true);
    });
  });

  describe('when agent has per-agent budget AND global cap is exceeded', () => {
    it('returns withinBudget: false and globalCapExceeded: true regardless of per-agent status', async () => {
      // Arrange: agent budget $500, agent spent $100 (under budget)
      // but global cap $1000 is met with $1000 global spend
      mockedAgentFindUnique.mockResolvedValueOnce({ monthlyBudgetUsd: 500 });
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 100 } });
      mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: 1000 });
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 1000 } });

      // Act
      const status = await checkBudget('agent-1');

      // Assert: withinBudget false because global cap exceeded, even though per-agent is ok
      expect(status.withinBudget).toBe(false);
      expect(status.globalCapExceeded).toBe(true);
      expect(status.limit).toBe(500);
      expect(status.remaining).toBe(400);
    });
  });

  describe('when settings lookup fails', () => {
    it('falls back to per-agent logic only (does not throw)', async () => {
      // Arrange
      mockedAgentFindUnique.mockResolvedValueOnce({ monthlyBudgetUsd: 100 });
      mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 30 } });
      // Settings lookup throws
      mockedSettingsFindUnique.mockRejectedValueOnce(new Error('settings DB error'));

      // Act
      let thrown = false;
      let status;
      try {
        status = await checkBudget('agent-1');
      } catch {
        thrown = true;
      }

      // Assert: never throws, per-agent budget logic still works
      expect(thrown).toBe(false);
      expect(status?.withinBudget).toBe(true);
      expect(status?.spent).toBe(30);
    });
  });
});
