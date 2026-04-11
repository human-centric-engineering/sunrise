/**
 * Cost Reports — aggregation queries over `AiCostLog`.
 *
 * Pure query module. No side effects. Platform-agnostic (no Next.js imports).
 * Powers the admin `/costs` endpoints:
 *
 *   - `getCostBreakdown` — group by day / agent / model for a date range
 *   - `getCostSummary`   — today / week / month totals + byAgent + byModel + 30-day trend
 *   - `getBudgetAlerts`  — agents at or above the warning threshold (>=80%)
 *
 * All month / day boundaries are computed in **UTC** to match
 * `cost-tracker.ts#checkBudget`.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CostBreakdownRow {
  /** Grouping key: ISO date (YYYY-MM-DD) for `day`, agentId for `agent`, model id for `model`. */
  key: string;
  /** Human-friendly label (agent name / model id). Undefined for `day`. */
  label?: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  count: number;
}

export interface CostBreakdownTotals {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  count: number;
}

export interface CostBreakdownResult {
  groupBy: 'day' | 'agent' | 'model';
  rows: CostBreakdownRow[];
  totals: CostBreakdownTotals;
}

export interface CostBreakdownOptions {
  agentId?: string;
  dateFrom: Date;
  dateTo: Date;
  groupBy: 'day' | 'agent' | 'model';
}

export interface CostSummaryAgentRow {
  agentId: string;
  name: string;
  slug: string;
  monthSpend: number;
  monthlyBudgetUsd: number | null;
  /** `spent / budget` (can exceed 1). `null` when budget is unset. */
  utilisation: number | null;
}

export interface CostSummaryModelRow {
  model: string;
  monthSpend: number;
}

export interface CostSummaryTrendPoint {
  /** ISO date (YYYY-MM-DD), UTC. */
  date: string;
  totalCostUsd: number;
}

export interface CostSummary {
  totals: { today: number; week: number; month: number };
  byAgent: CostSummaryAgentRow[];
  byModel: CostSummaryModelRow[];
  /** Last 30 UTC days in ascending order. Days with no spend are omitted. */
  trend: CostSummaryTrendPoint[];
}

export interface BudgetAlert {
  agentId: string;
  name: string;
  slug: string;
  monthlyBudgetUsd: number;
  spent: number;
  utilisation: number;
  severity: 'warning' | 'critical';
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const BUDGET_WARNING_THRESHOLD = 0.8;
const BUDGET_CRITICAL_THRESHOLD = 1.0;

function utcStartOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function utcStartOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// getCostBreakdown
// ----------------------------------------------------------------------------

interface DayGroupRow {
  day: Date;
  total_cost_usd: number | string;
  input_tokens: number | bigint | string;
  output_tokens: number | bigint | string;
  row_count: number | bigint | string;
}

function toNumber(value: number | bigint | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value) || 0;
}

/**
 * Run an aggregated query against `AiCostLog` for the given window and
 * grouping. `dateFrom` is inclusive at UTC midnight; `dateTo` is inclusive
 * for the whole UTC day (i.e. we bump it to the next midnight and use
 * `<`).
 */
export async function getCostBreakdown(opts: CostBreakdownOptions): Promise<CostBreakdownResult> {
  const fromBoundary = utcStartOfDay(opts.dateFrom);
  const toBoundary = new Date(utcStartOfDay(opts.dateTo).getTime() + MS_PER_DAY);

  const where = {
    createdAt: { gte: fromBoundary, lt: toBoundary },
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  };

  let rows: CostBreakdownRow[];

  if (opts.groupBy === 'day') {
    // Postgres-native date_trunc. Prisma's groupBy can't truncate to a day,
    // so we drop into $queryRaw. This is the repo's existing posture — pgvector
    // already pins us to Postgres, so raw SQL is acceptable here.
    const params: unknown[] = [fromBoundary, toBoundary];
    let whereSql = `"createdAt" >= $1 AND "createdAt" < $2`;
    if (opts.agentId) {
      params.push(opts.agentId);
      whereSql += ` AND "agentId" = $3`;
    }

    const raw = await prisma.$queryRawUnsafe<DayGroupRow[]>(
      `
      SELECT
        date_trunc('day', "createdAt") AS day,
        SUM("totalCostUsd") AS total_cost_usd,
        SUM("inputTokens")  AS input_tokens,
        SUM("outputTokens") AS output_tokens,
        COUNT(*)            AS row_count
      FROM "ai_cost_log"
      WHERE ${whereSql}
      GROUP BY day
      ORDER BY day ASC
      `,
      ...params
    );

    rows = raw.map((r) => ({
      key: isoDate(r.day),
      totalCostUsd: toNumber(r.total_cost_usd),
      inputTokens: toNumber(r.input_tokens),
      outputTokens: toNumber(r.output_tokens),
      count: toNumber(r.row_count),
    }));
  } else if (opts.groupBy === 'agent') {
    const grouped = await prisma.aiCostLog.groupBy({
      by: ['agentId'],
      where,
      _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
    });

    const agentIds = grouped
      .map((g) => g.agentId)
      .filter((id): id is string => typeof id === 'string');

    const agents = agentIds.length
      ? await prisma.aiAgent.findMany({
          where: { id: { in: agentIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(agents.map((a) => [a.id, a.name]));

    rows = grouped.map((g) => ({
      key: g.agentId ?? '(deleted)',
      label: g.agentId ? (nameById.get(g.agentId) ?? '(unknown agent)') : '(deleted)',
      totalCostUsd: g._sum.totalCostUsd ?? 0,
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      count: g._count._all,
    }));
    rows.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  } else {
    const grouped = await prisma.aiCostLog.groupBy({
      by: ['model'],
      where,
      _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
    });

    rows = grouped.map((g) => ({
      key: g.model,
      label: g.model,
      totalCostUsd: g._sum.totalCostUsd ?? 0,
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      count: g._count._all,
    }));
    rows.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  const totals = rows.reduce<CostBreakdownTotals>(
    (acc, r) => {
      acc.totalCostUsd += r.totalCostUsd;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.count += r.count;
      return acc;
    },
    { totalCostUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 }
  );

  return { groupBy: opts.groupBy, rows, totals };
}

// ----------------------------------------------------------------------------
// getCostSummary
// ----------------------------------------------------------------------------

interface TrendRow {
  day: Date;
  total_cost_usd: number | string;
}

/**
 * Today / this-week / this-month totals plus per-agent and per-model
 * month-to-date spend, plus a 30-day trend line.
 *
 * All boundaries are UTC. "This week" is the rolling 7 days ending at
 * next UTC midnight (i.e. `[todayStart - 6d, tomorrowStart)`).
 */
export async function getCostSummary(): Promise<CostSummary> {
  const now = new Date();
  const todayStart = utcStartOfDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + MS_PER_DAY);
  const weekStart = new Date(todayStart.getTime() - 6 * MS_PER_DAY);
  const monthStart = utcStartOfMonth(now);
  const trendStart = new Date(todayStart.getTime() - 29 * MS_PER_DAY);

  const [todayAgg, weekAgg, monthAgg, byAgentGrouped, byModelGrouped, trendRaw, agentsWithBudget] =
    await Promise.all([
      prisma.aiCostLog.aggregate({
        where: { createdAt: { gte: todayStart, lt: tomorrowStart } },
        _sum: { totalCostUsd: true },
      }),
      prisma.aiCostLog.aggregate({
        where: { createdAt: { gte: weekStart, lt: tomorrowStart } },
        _sum: { totalCostUsd: true },
      }),
      prisma.aiCostLog.aggregate({
        where: { createdAt: { gte: monthStart } },
        _sum: { totalCostUsd: true },
      }),
      prisma.aiCostLog.groupBy({
        by: ['agentId'],
        where: { createdAt: { gte: monthStart }, agentId: { not: null } },
        _sum: { totalCostUsd: true },
      }),
      prisma.aiCostLog.groupBy({
        by: ['model'],
        where: { createdAt: { gte: monthStart } },
        _sum: { totalCostUsd: true },
      }),
      prisma.$queryRawUnsafe<TrendRow[]>(
        `
        SELECT
          date_trunc('day', "createdAt") AS day,
          SUM("totalCostUsd") AS total_cost_usd
        FROM "ai_cost_log"
        WHERE "createdAt" >= $1 AND "createdAt" < $2
        GROUP BY day
        ORDER BY day ASC
        `,
        trendStart,
        tomorrowStart
      ),
      prisma.aiAgent.findMany({
        select: { id: true, name: true, slug: true, monthlyBudgetUsd: true },
      }),
    ]);

  const agentById = new Map(agentsWithBudget.map((a) => [a.id, a]));

  const byAgent: CostSummaryAgentRow[] = byAgentGrouped
    .map((g): CostSummaryAgentRow | null => {
      if (!g.agentId) return null;
      const agent = agentById.get(g.agentId);
      if (!agent) return null;
      const monthSpend = g._sum.totalCostUsd ?? 0;
      const budget = agent.monthlyBudgetUsd ?? null;
      return {
        agentId: agent.id,
        name: agent.name,
        slug: agent.slug,
        monthSpend,
        monthlyBudgetUsd: budget,
        utilisation: budget && budget > 0 ? monthSpend / budget : null,
      };
    })
    .filter((r): r is CostSummaryAgentRow => r !== null)
    .sort((a, b) => b.monthSpend - a.monthSpend);

  const byModel: CostSummaryModelRow[] = byModelGrouped
    .map((g) => ({ model: g.model, monthSpend: g._sum.totalCostUsd ?? 0 }))
    .sort((a, b) => b.monthSpend - a.monthSpend);

  const trend: CostSummaryTrendPoint[] = trendRaw.map((r) => ({
    date: isoDate(r.day),
    totalCostUsd: toNumber(r.total_cost_usd),
  }));

  return {
    totals: {
      today: todayAgg._sum.totalCostUsd ?? 0,
      week: weekAgg._sum.totalCostUsd ?? 0,
      month: monthAgg._sum.totalCostUsd ?? 0,
    },
    byAgent,
    byModel,
    trend,
  };
}

// ----------------------------------------------------------------------------
// getBudgetAlerts
// ----------------------------------------------------------------------------

/**
 * Returns every agent whose month-to-date spend has hit the warning
 * threshold (>=80% of its budget). Agents without a `monthlyBudgetUsd`
 * or with a non-positive budget are excluded. Sorted by severity + utilisation.
 */
export async function getBudgetAlerts(): Promise<BudgetAlert[]> {
  const agents = await prisma.aiAgent.findMany({
    where: { monthlyBudgetUsd: { not: null } },
    select: { id: true, name: true, slug: true, monthlyBudgetUsd: true },
  });
  if (agents.length === 0) return [];

  const now = new Date();
  const monthStart = utcStartOfMonth(now);

  const grouped = await prisma.aiCostLog.groupBy({
    by: ['agentId'],
    where: {
      createdAt: { gte: monthStart },
      agentId: { in: agents.map((a) => a.id) },
    },
    _sum: { totalCostUsd: true },
  });
  const spendById = new Map<string, number>(
    grouped
      .filter((g): g is typeof g & { agentId: string } => typeof g.agentId === 'string')
      .map((g) => [g.agentId, g._sum.totalCostUsd ?? 0])
  );

  const alerts: BudgetAlert[] = [];
  for (const agent of agents) {
    const budget = agent.monthlyBudgetUsd;
    if (budget === null || budget === undefined || budget <= 0) continue;
    const spent = spendById.get(agent.id) ?? 0;
    const utilisation = spent / budget;
    if (utilisation < BUDGET_WARNING_THRESHOLD) continue;
    alerts.push({
      agentId: agent.id,
      name: agent.name,
      slug: agent.slug,
      monthlyBudgetUsd: budget,
      spent,
      utilisation,
      severity: utilisation >= BUDGET_CRITICAL_THRESHOLD ? 'critical' : 'warning',
    });
  }

  alerts.sort((a, b) => b.utilisation - a.utilisation);

  logger.debug('Budget alerts computed', {
    total: alerts.length,
    critical: alerts.filter((a) => a.severity === 'critical').length,
  });

  return alerts;
}
