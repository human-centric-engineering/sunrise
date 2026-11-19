/**
 * Unit tests for cost-reports.ts — aggregation queries over AiCostLog.
 *
 * All Prisma methods are mocked. The tests cover:
 *  - getCostBreakdown: groupBy day (raw SQL), agent (groupBy + name lookup), model
 *  - getCostSummary: today/week/month totals, byAgent utilisation (incl. null budget), trend shape
 *  - getBudgetAlerts: warning/critical thresholds, null/zero budget filtering, sort order
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCostLog: {
      aggregate: vi.fn(),
      groupBy: vi.fn(),
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

const { prisma } = await import('@/lib/db/client');
const { getCostBreakdown, getCostSummary, getBudgetAlerts } =
  await import('@/lib/orchestration/llm/cost-reports');

// Typed shortcuts.
const mockedGroupBy = prisma.aiCostLog.groupBy as unknown as ReturnType<typeof vi.fn>;
const mockedAgentFind = prisma.aiAgent.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedRaw = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// getCostBreakdown
// ---------------------------------------------------------------------------

describe('getCostBreakdown', () => {
  const dateFrom = new Date('2026-03-01T00:00:00.000Z');
  const dateTo = new Date('2026-03-07T00:00:00.000Z');

  it('group by day uses $queryRawUnsafe with date_trunc and returns ISO dates', async () => {
    mockedRaw.mockResolvedValueOnce([
      {
        day: new Date('2026-03-01T00:00:00.000Z'),
        total_cost_usd: 1.5,
        input_tokens: 1000,
        output_tokens: 500,
        row_count: 3,
      },
      {
        day: new Date('2026-03-02T00:00:00.000Z'),
        total_cost_usd: 2.25,
        input_tokens: 2000,
        output_tokens: 800,
        row_count: 5,
      },
    ]);

    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'day' });

    expect(mockedRaw).toHaveBeenCalledTimes(1);
    const sql = mockedRaw.mock.calls[0][0] as string;
    expect(sql).toContain("date_trunc('day'");
    expect(result.groupBy).toBe('day');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ key: '2026-03-01', totalCostUsd: 1.5, count: 3 });
    expect(result.totals.totalCostUsd).toBeCloseTo(3.75);
    expect(result.totals.inputTokens).toBe(3000);
    expect(result.totals.count).toBe(8);
  });

  it('group by day forwards agentId as a raw-query parameter', async () => {
    mockedRaw.mockResolvedValueOnce([]);
    await getCostBreakdown({
      agentId: 'agent-1',
      dateFrom,
      dateTo,
      groupBy: 'day',
    });
    const callArgs = mockedRaw.mock.calls[0];
    const sql = callArgs[0] as string;
    expect(sql).toContain('"agentId" = $3');
    expect(callArgs).toContain('agent-1');
  });

  it('group by day coerces bigint/string aggregates to numbers', async () => {
    mockedRaw.mockResolvedValueOnce([
      {
        day: new Date('2026-03-01T00:00:00.000Z'),
        total_cost_usd: '1.5',
        input_tokens: BigInt(1000),
        output_tokens: BigInt(500),
        row_count: BigInt(3),
      },
    ]);
    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'day' });
    expect(result.rows[0].totalCostUsd).toBe(1.5);
    expect(result.rows[0].inputTokens).toBe(1000);
    expect(result.rows[0].count).toBe(3);
  });

  it('group by agent uses Prisma groupBy and resolves names in one batch', async () => {
    mockedGroupBy.mockResolvedValueOnce([
      {
        agentId: 'agent-a',
        _sum: { totalCostUsd: 10, inputTokens: 1000, outputTokens: 500 },
        _count: { _all: 4 },
      },
      {
        agentId: 'agent-b',
        _sum: { totalCostUsd: 5, inputTokens: 500, outputTokens: 250 },
        _count: { _all: 2 },
      },
    ]);
    mockedAgentFind.mockResolvedValueOnce([
      { id: 'agent-a', name: 'Agent A' },
      { id: 'agent-b', name: 'Agent B' },
    ]);

    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'agent' });

    expect(mockedAgentFind).toHaveBeenCalledTimes(1);
    expect(mockedAgentFind.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['agent-a', 'agent-b'] } },
    });
    expect(result.groupBy).toBe('agent');
    // Sorted by totalCostUsd descending.
    expect(result.rows[0]).toMatchObject({ key: 'agent-a', label: 'Agent A', totalCostUsd: 10 });
    expect(result.rows[1]).toMatchObject({ key: 'agent-b', label: 'Agent B', totalCostUsd: 5 });
    expect(result.totals.totalCostUsd).toBe(15);
    expect(result.totals.count).toBe(6);
  });

  it('group by agent handles deleted agents (null agentId) with a placeholder label', async () => {
    mockedGroupBy.mockResolvedValueOnce([
      {
        agentId: null,
        _sum: { totalCostUsd: 2, inputTokens: 100, outputTokens: 50 },
        _count: { _all: 1 },
      },
    ]);
    mockedAgentFind.mockResolvedValueOnce([]);

    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'agent' });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].key).toBe('(deleted)');
    expect(result.rows[0].label).toBe('(deleted)');
  });

  it('group by agent skips the name lookup entirely when there are no rows', async () => {
    mockedGroupBy.mockResolvedValueOnce([]);
    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'agent' });
    expect(mockedAgentFind).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.totals.totalCostUsd).toBe(0);
  });

  it('group by agent coerces null _sum aggregates to zero', async () => {
    mockedGroupBy.mockResolvedValueOnce([
      {
        agentId: 'agent-a',
        _sum: { totalCostUsd: null, inputTokens: null, outputTokens: null },
        _count: { _all: 0 },
      },
    ]);
    mockedAgentFind.mockResolvedValueOnce([{ id: 'agent-a', name: 'Agent A' }]);

    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'agent' });

    expect(result.rows[0]).toMatchObject({
      key: 'agent-a',
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('group by model coerces null _sum aggregates to zero', async () => {
    mockedGroupBy.mockResolvedValueOnce([
      {
        model: 'claude-sonnet-4-6',
        _sum: { totalCostUsd: null, inputTokens: null, outputTokens: null },
        _count: { _all: 0 },
      },
    ]);
    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'model' });
    expect(result.rows[0]).toMatchObject({
      key: 'claude-sonnet-4-6',
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('group by agent labels unknown agents (returned by groupBy but missing from lookup)', async () => {
    mockedGroupBy.mockResolvedValueOnce([
      {
        agentId: 'ghost',
        _sum: { totalCostUsd: 1, inputTokens: 10, outputTokens: 5 },
        _count: { _all: 1 },
      },
    ]);
    mockedAgentFind.mockResolvedValueOnce([]);
    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'agent' });
    expect(result.rows[0]).toMatchObject({ key: 'ghost', label: '(unknown agent)' });
  });

  it('group by model sorts rows by totalCostUsd descending', async () => {
    mockedGroupBy.mockResolvedValueOnce([
      {
        model: 'claude-sonnet-4-6',
        _sum: { totalCostUsd: 3, inputTokens: 300, outputTokens: 100 },
        _count: { _all: 2 },
      },
      {
        model: 'claude-opus-4-6',
        _sum: { totalCostUsd: 9, inputTokens: 900, outputTokens: 450 },
        _count: { _all: 1 },
      },
    ]);

    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'model' });

    expect(result.groupBy).toBe('model');
    expect(result.rows[0].key).toBe('claude-opus-4-6');
    expect(result.rows[0].label).toBe('claude-opus-4-6');
    expect(result.rows[1].key).toBe('claude-sonnet-4-6');
    expect(result.totals.totalCostUsd).toBe(12);
  });

  it('passes agentId filter through to groupBy where clause', async () => {
    mockedGroupBy.mockResolvedValueOnce([]);
    await getCostBreakdown({ agentId: 'agent-1', dateFrom, dateTo, groupBy: 'model' });
    const where = mockedGroupBy.mock.calls[0][0].where;
    expect(where.agentId).toBe('agent-1');
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// getCostSummary
// ---------------------------------------------------------------------------

describe('getCostBreakdown — spend on orgs’ own keys (§137 t-1058)', () => {
  const dateFrom = new Date('2026-03-01T00:00:00.000Z');
  const dateTo = new Date('2026-03-07T00:00:00.000Z');

  it('by day, says how much of each day was on own keys, summed by the query', async () => {
    mockedRaw.mockResolvedValueOnce([
      {
        day: new Date('2026-03-01T00:00:00.000Z'),
        total_cost_usd: '60',
        own_key_cost_usd: '50',
        input_tokens: 10,
        output_tokens: 5,
        row_count: 2,
      },
      {
        day: new Date('2026-03-02T00:00:00.000Z'),
        total_cost_usd: 4,
        own_key_cost_usd: 0,
        input_tokens: 1,
        output_tokens: 1,
        row_count: 1,
      },
    ]);

    const result = await getCostBreakdown({ dateFrom, dateTo, groupBy: 'day' });

    expect(result.rows.map((r) => [r.key, r.totalCostUsd, r.ownKeyCostUsd])).toEqual([
      ['2026-03-01', 60, 50],
      ['2026-03-02', 4, 0],
    ]);
    expect(result.totals).toMatchObject({ totalCostUsd: 64, ownKeyCostUsd: 50 });
    const sql = (mockedRaw.mock.calls[0][0] as string).replace(/\s+/g, ' ');
    expect(sql).toContain(
      'SUM(CASE WHEN "ownKey" THEN "totalCostUsd" ELSE 0 END) AS own_key_cost_usd'
    );
  });

  it.each([
    ['agent', 'agentId'],
    ['model', 'model'],
  ] as const)(
    'by %s, folds the own-key and platform halves into one row',
    async (groupBy, field) => {
      mockedGroupBy.mockResolvedValueOnce([
        {
          [field]: 'a',
          ownKey: false,
          _sum: { totalCostUsd: 2, inputTokens: 20, outputTokens: 2 },
          _count: { _all: 1 },
        },
        {
          [field]: 'b',
          ownKey: true,
          _sum: { totalCostUsd: 4, inputTokens: 40, outputTokens: 4 },
          _count: { _all: 2 },
        },
        {
          [field]: 'a',
          ownKey: true,
          _sum: { totalCostUsd: 3, inputTokens: 30, outputTokens: 3 },
          _count: { _all: 3 },
        },
      ]);
      // Only the agent breakdown looks names up; a queued answer left over
      // would be another test's.
      if (groupBy === 'agent') {
        mockedAgentFind.mockResolvedValueOnce([
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ]);
      }

      const result = await getCostBreakdown({ dateFrom, dateTo, groupBy });

      expect(mockedGroupBy.mock.calls[0][0]).toMatchObject({ by: [field, 'ownKey'] });
      expect(result.rows).toEqual([
        expect.objectContaining({
          key: 'a',
          totalCostUsd: 5,
          ownKeyCostUsd: 3,
          inputTokens: 50,
          outputTokens: 5,
          count: 4,
        }),
        expect.objectContaining({
          key: 'b',
          totalCostUsd: 4,
          ownKeyCostUsd: 4,
          inputTokens: 40,
          outputTokens: 4,
          count: 2,
        }),
      ]);
      expect(result.totals).toEqual({
        totalCostUsd: 9,
        ownKeyCostUsd: 7,
        inputTokens: 90,
        outputTokens: 9,
        count: 6,
      });
    }
  );
});

describe('getCostSummary', () => {
  it('returns today/week/month totals and populates byAgent with utilisation', async () => {
    // Today, week and month, each grouped by ownKey (§137).
    mockedGroupBy
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 1.1 } }])
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 5.5 } }])
      // The month's 20 includes 5 on an org's own key.
      .mockResolvedValueOnce([
        { ownKey: false, _sum: { totalCostUsd: 15 } },
        { ownKey: true, _sum: { totalCostUsd: 5 } },
      ]);

    mockedGroupBy
      .mockResolvedValueOnce([
        { agentId: 'agent-a', _sum: { totalCostUsd: 12 } },
        { agentId: 'agent-b', _sum: { totalCostUsd: 8 } },
      ]) // byAgent
      .mockResolvedValueOnce([
        { model: 'claude-sonnet-4-6', _sum: { totalCostUsd: 15 } },
        { model: 'claude-haiku-4-5', _sum: { totalCostUsd: 5 } },
      ]); // byModel

    mockedRaw.mockResolvedValueOnce([
      { day: new Date('2026-03-20T00:00:00.000Z'), total_cost_usd: 3 },
      { day: new Date('2026-03-21T00:00:00.000Z'), total_cost_usd: 7 },
    ]);

    mockedAgentFind.mockResolvedValueOnce([
      { id: 'agent-a', name: 'Agent A', slug: 'a', monthlyBudgetUsd: 20 },
      { id: 'agent-b', name: 'Agent B', slug: 'b', monthlyBudgetUsd: null },
    ]);

    const summary = await getCostSummary();

    expect(summary.totals).toEqual({ today: 1.1, week: 5.5, month: 20 });
    // The own-key part, apart (§137): the platform's month is 15.
    expect(summary.ownKey).toEqual({ today: 0, week: 0, month: 5 });
    const windows = mockedGroupBy.mock.calls.slice(0, 3).map(([args]) => args as { by: string[] });
    expect(windows.map((w) => w.by)).toEqual([['ownKey'], ['ownKey'], ['ownKey']]);

    expect(summary.byAgent).toHaveLength(2);
    // Sorted by monthSpend desc.
    const [first, second] = summary.byAgent;
    expect(first).toMatchObject({
      agentId: 'agent-a',
      monthSpend: 12,
      monthlyBudgetUsd: 20,
      utilisation: 0.6,
    });
    expect(second).toMatchObject({
      agentId: 'agent-b',
      monthSpend: 8,
      monthlyBudgetUsd: null,
      utilisation: null,
    });

    expect(summary.byModel).toEqual([
      { model: 'claude-sonnet-4-6', monthSpend: 15, ownKeyMonthSpend: 0 },
      { model: 'claude-haiku-4-5', monthSpend: 5, ownKeyMonthSpend: 0 },
    ]);

    expect(summary.trend).toEqual([
      { date: '2026-03-20', totalCostUsd: 3, ownKeyCostUsd: 0 },
      { date: '2026-03-21', totalCostUsd: 7, ownKeyCostUsd: 0 },
    ]);
  });

  it('coerces null _sum.totalCostUsd to zero in byAgent and byModel rows', async () => {
    // Today, week and month, each grouped by ownKey (§137).
    mockedGroupBy
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 0 } }])
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 0 } }])
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: 0 } }]);

    mockedGroupBy
      .mockResolvedValueOnce([{ agentId: 'agent-a', _sum: { totalCostUsd: null } }])
      .mockResolvedValueOnce([{ model: 'claude-sonnet-4-6', _sum: { totalCostUsd: null } }]);

    mockedRaw.mockResolvedValueOnce([]);
    mockedAgentFind.mockResolvedValueOnce([
      { id: 'agent-a', name: 'Agent A', slug: 'a', monthlyBudgetUsd: 100 },
    ]);

    const summary = await getCostSummary();
    expect(summary.byAgent[0]).toMatchObject({ monthSpend: 0, utilisation: 0 });
    expect(summary.byModel[0]).toMatchObject({ model: 'claude-sonnet-4-6', monthSpend: 0 });
  });

  it('treats missing _sum.totalCostUsd as zero and surfaces orphaned agents', async () => {
    // Today, week and month, each grouped by ownKey (§137).
    mockedGroupBy
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: null } }])
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: null } }])
      .mockResolvedValueOnce([{ ownKey: false, _sum: { totalCostUsd: null } }]);

    // One row with a null agentId (shouldn't happen due to where clause but we defend),
    // and one with an agent that no longer exists ('ghost').
    mockedGroupBy
      .mockResolvedValueOnce([
        { agentId: null, _sum: { totalCostUsd: 4 } },
        { agentId: 'ghost', _sum: { totalCostUsd: 9 } },
      ])
      .mockResolvedValueOnce([]);

    mockedRaw.mockResolvedValueOnce([]);
    // 'ghost' isn't in the agents lookup — surfaces as (deleted).
    mockedAgentFind.mockResolvedValueOnce([]);

    const summary = await getCostSummary();

    expect(summary.totals).toEqual({ today: 0, week: 0, month: 0 });
    // Orphaned agent rows surface as (deleted) so sum(byAgent) matches totals.month
    expect(summary.byAgent).toHaveLength(1);
    expect(summary.byAgent[0]).toMatchObject({
      agentId: 'ghost',
      name: '(deleted)',
      slug: '(deleted)',
      monthSpend: 9,
      monthlyBudgetUsd: null,
      utilisation: null,
    });
    expect(summary.byModel).toEqual([]);
    expect(summary.trend).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getBudgetAlerts
// ---------------------------------------------------------------------------

describe('getBudgetAlerts', () => {
  it('returns empty list when no agents have budgets set', async () => {
    mockedAgentFind.mockResolvedValueOnce([]);
    const alerts = await getBudgetAlerts();
    expect(alerts).toEqual([]);
    expect(mockedGroupBy).not.toHaveBeenCalled();
  });

  it('classifies severity and omits agents below the warning threshold', async () => {
    mockedAgentFind.mockResolvedValueOnce([
      { id: 'ok', name: 'Ok', slug: 'ok', monthlyBudgetUsd: 100 },
      { id: 'warn', name: 'Warn', slug: 'warn', monthlyBudgetUsd: 100 },
      { id: 'crit', name: 'Crit', slug: 'crit', monthlyBudgetUsd: 100 },
      { id: 'zero', name: 'Zero', slug: 'zero', monthlyBudgetUsd: 0 },
    ]);
    mockedGroupBy.mockResolvedValueOnce([
      { agentId: 'ok', _sum: { totalCostUsd: 50 } },
      { agentId: 'warn', _sum: { totalCostUsd: 85 } },
      { agentId: 'crit', _sum: { totalCostUsd: 150 } },
      { agentId: 'zero', _sum: { totalCostUsd: 1 } },
    ]);

    const alerts = await getBudgetAlerts();

    // `ok` under 0.8 → excluded. `zero` non-positive budget → excluded.
    expect(alerts.map((a) => a.agentId)).toEqual(['crit', 'warn']);
    expect(alerts[0]).toMatchObject({ severity: 'critical', utilisation: 1.5 });
    expect(alerts[1]).toMatchObject({ severity: 'warning', utilisation: 0.85 });
  });

  it('defaults spent to 0 for agents with a budget but no cost rows this month', async () => {
    mockedAgentFind.mockResolvedValueOnce([
      { id: 'quiet', name: 'Quiet', slug: 'quiet', monthlyBudgetUsd: 50 },
    ]);
    mockedGroupBy.mockResolvedValueOnce([]);

    const alerts = await getBudgetAlerts();
    // 0 / 50 = 0 → below warning → no alert.
    expect(alerts).toEqual([]);
  });

  it('coerces null _sum.totalCostUsd to zero when computing spend per agent', async () => {
    mockedAgentFind.mockResolvedValueOnce([
      { id: 'maybe', name: 'Maybe', slug: 'maybe', monthlyBudgetUsd: 100 },
    ]);
    mockedGroupBy.mockResolvedValueOnce([{ agentId: 'maybe', _sum: { totalCostUsd: null } }]);
    const alerts = await getBudgetAlerts();
    // null → 0 → below warning → excluded.
    expect(alerts).toEqual([]);
  });

  it('treats utilisation at exactly 1.0 as critical, and exactly 0.8 as warning', async () => {
    mockedAgentFind.mockResolvedValueOnce([
      { id: 'exact-warn', name: 'W', slug: 'w', monthlyBudgetUsd: 100 },
      { id: 'exact-crit', name: 'C', slug: 'c', monthlyBudgetUsd: 100 },
    ]);
    mockedGroupBy.mockResolvedValueOnce([
      { agentId: 'exact-warn', _sum: { totalCostUsd: 80 } },
      { agentId: 'exact-crit', _sum: { totalCostUsd: 100 } },
    ]);

    const alerts = await getBudgetAlerts();
    const warn = alerts.find((a) => a.agentId === 'exact-warn');
    const crit = alerts.find((a) => a.agentId === 'exact-crit');
    expect(warn?.severity).toBe('warning');
    expect(crit?.severity).toBe('critical');
  });
});
