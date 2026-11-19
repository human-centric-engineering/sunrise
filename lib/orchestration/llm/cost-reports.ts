/**
 * Cost Reports — aggregation queries over `AiCostLog`.
 *
 * Pure query module. No side effects. Platform-agnostic (no Next.js imports).
 * Powers the admin `/costs` endpoints:
 *
 *   - `getCostBreakdown` — group by day / agent / model for a date range
 *   - `getCostSummary`   — today / week / month totals + byAgent + byModel + 30-day trend
 *   - `getBudgetAlerts`  — agents at or above the warning threshold (>=80%)
 *   - `getOrgUsage`      — each org's spend for one UTC calendar month, against its cap
 *
 * All month / day boundaries are computed in **UTC** to match
 * `cost-tracker.ts#checkBudget`.
 *
 * **Spend on an org's own key is reported apart** (§137). Every total here
 * still includes it, and the summary and the org usage say how much of it was
 * on the org's own key (`ownKey`, `ownKeyCostUsd`): the vendor bills the org
 * for that part, so it is not the platform's spend, and the org's and the
 * global caps leave it out. So does each trend point, each model row and each
 * breakdown row (t-1058). An agent's spend in the summary keeps it with no
 * split, since the agent's cap counts it.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { calculateLocalSavings, getGlobalCapState } from '@/lib/orchestration/llm/cost-tracker';
import { utcMonthStart } from '@/lib/orchestration/llm/spend-caps';
import { canChangeSharedSettings } from '@/lib/tenancy/shared-settings';
import { isMultiTenant, runAsSystem } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { readOrgQuotas } from '@/lib/tenancy/org-settings';
import type { LocalSavingsResult } from '@/types/orchestration';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CostBreakdownRow {
  /** Grouping key: ISO date (YYYY-MM-DD) for `day`, agentId for `agent`, model id for `model`. */
  key: string;
  /** Human-friendly label (agent name / model id). Undefined for `day`. */
  label?: string;
  /** All of the row's spend, the part on orgs' own keys included. */
  totalCostUsd: number;
  /** The part of `totalCostUsd` on an org's own key (§137 t-1058). */
  ownKeyCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  count: number;
}

export interface CostBreakdownTotals {
  totalCostUsd: number;
  /** The part of `totalCostUsd` on an org's own key (§137 t-1058). */
  ownKeyCostUsd: number;
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
  /**
   * Provider slug that actually served the spend, from `AiCostLog.provider`.
   *
   * Load-bearing for display: the same bare `modelId` can exist under several
   * providers in the catalogue (`gpt-4o` ships under both `openai` and
   * `microsoft`), so a consumer resolving a row to `ModelInfo` must key on
   * `provider::model` or it renders whichever catalogue entry happened to land
   * last — a provider the operator may never have configured.
   */
  provider: string;
  /** All of the model's spend this month, the part on orgs' own keys included. */
  monthSpend: number;
  /** The part of `monthSpend` on an org's own key (§137 t-1058). */
  ownKeyMonthSpend: number;
}

export interface CostSummaryTrendPoint {
  /** ISO date (YYYY-MM-DD), UTC. */
  date: string;
  /** All of the day's spend, the part on orgs' own keys included. */
  totalCostUsd: number;
  /** The part of `totalCostUsd` on an org's own key (§137 t-1058). */
  ownKeyCostUsd: number;
}

export interface CostSummary {
  /** All spend in each window, the part on orgs' own keys included. */
  totals: { today: number; week: number; month: number };
  /**
   * The part of each of `totals` made on an org's own key (§137): billed to
   * the org by the vendor, not to the platform. `totals` minus this is the
   * platform's spend.
   */
  ownKey: { today: number; week: number; month: number };
  byAgent: CostSummaryAgentRow[];
  byModel: CostSummaryModelRow[];
  /** Last 30 UTC days in ascending order. Days with no spend are omitted. */
  trend: CostSummaryTrendPoint[];
  /**
   * Hypothetical savings from local models over the rolling month window.
   * `null` when the helper errored (the rest of the summary still renders).
   */
  localSavings: LocalSavingsResult | null;
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

/** The global cap, its month-to-date spend in every org, and whether it is met. */
export interface GlobalCapStatus {
  /** The configured global monthly budget in USD, or null if not set. */
  cap: number | null;
  /**
   * Month-to-date spend in every org on the platform's keys: spend on an org's
   * own key is not counted (§137). `null` for a caller in a customer org at
   * `multi`: the figure includes every other org's spend, so it is shown only
   * in the install org, where the global cap is set.
   */
  spent: number | null;
  /** True when the spend has reached the cap: every paid AI call is refused. */
  exceeded: boolean;
}

/** Spend, calls and tokens for one bucket of `AiCostLog` rows. */
export interface UsageTotals {
  /** All spend, the part on the org's own key included. */
  totalCostUsd: number;
  /**
   * The part of `totalCostUsd` made on the org's own key (§137): billed to the
   * org by the vendor, so not the platform's spend, and not counted towards
   * the org's cap or the global one.
   */
  ownKeyCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Number of cost rows: one per metered call. */
  count: number;
}

/** One org's usage for the period, beside its monthly cap. */
export interface OrgUsageRow extends UsageTotals {
  orgId: string;
  name: string;
  slug: string;
  status: string;
  /** The org's `quotas.monthlyBudgetUsd`; `null` when it has set none. */
  monthlyBudgetUsd: number | null;
  /**
   * The platform's spend over the cap, `(totalCostUsd - ownKeyCostUsd) / cap`
   * (can exceed 1): what the cap counts. `null` when there is no cap, or the
   * cap is 0.
   */
  utilisation: number | null;
}

export interface OrgUsageReport {
  /** The UTC calendar month, `YYYY-MM`. */
  period: string;
  /** Inclusive start of the month, ISO. */
  periodStart: string;
  /** Exclusive end of the month (the next month's start), ISO. */
  periodEnd: string;
  /** Every org (or the one asked for), highest spend first. Orgs with no spend are included. */
  orgs: OrgUsageRow[];
  /**
   * Rows with no org: an erased org's detached spend (`onDelete: SetNull`) and
   * legacy rows. `null` at `single`, where those rows are the install org's
   * and are counted in its row.
   */
  detached: UsageTotals | null;
  /** Every row in the period: the org rows plus the detached bucket. */
  totals: UsageTotals;
}

export interface OrgUsageOptions {
  /** The UTC calendar month, `YYYY-MM`. */
  period: string;
  /** Narrow `orgs` to this one org. The detached bucket is then `null`. */
  orgId?: string;
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

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// getCostBreakdown
// ----------------------------------------------------------------------------

interface DayGroupRow {
  day: Date;
  total_cost_usd: number | string;
  own_key_cost_usd: number | string;
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
        SUM(CASE WHEN "ownKey" THEN "totalCostUsd" ELSE 0 END) AS own_key_cost_usd,
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
      ownKeyCostUsd: toNumber(r.own_key_cost_usd),
      inputTokens: toNumber(r.input_tokens),
      outputTokens: toNumber(r.output_tokens),
      count: toNumber(r.row_count),
    }));
  } else if (opts.groupBy === 'agent') {
    // By `ownKey` too, folded back to one row per agent below.
    const grouped = foldOwnKeyGroups(
      await prisma.aiCostLog.groupBy({
        by: ['agentId', 'ownKey'],
        where,
        _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
      (g) => g.agentId
    );

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
      ...g.sums,
    }));
    rows.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  } else {
    const grouped = foldOwnKeyGroups(
      await prisma.aiCostLog.groupBy({
        by: ['model', 'ownKey'],
        where,
        _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
      (g) => g.model
    );

    rows = grouped.map((g) => ({ key: g.model, label: g.model, ...g.sums }));
    rows.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  const totals = rows.reduce<CostBreakdownTotals>(
    (acc, r) => {
      acc.totalCostUsd += r.totalCostUsd;
      acc.ownKeyCostUsd += r.ownKeyCostUsd;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.count += r.count;
      return acc;
    },
    { totalCostUsd: 0, ownKeyCostUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 }
  );

  return { groupBy: opts.groupBy, rows, totals };
}

/** A `groupBy` row that `ownKey` is among the keys of. */
interface OwnKeyGroup {
  ownKey: boolean;
  _sum: {
    totalCostUsd: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  };
  /** Absent when the read does not count rows (the summary's `byModel`). */
  _count?: { _all: number };
}

/** What a fold adds up for one key: the sums of both halves, and the own-key part. */
type OwnKeySums = Omit<CostBreakdownRow, 'key' | 'label'>;

/**
 * Fold `groupBy` rows split by `ownKey` back into one per `keyOf`, in the
 * order each key is first seen. Each result keeps the grouping fields of the
 * first row seen for its key, and `sums`: the sums of both halves, and the
 * own-key part of the spend. A row's own `_sum`, `_count` and `ownKey` are
 * left out, since they would hold only one half. `sums.count` is 0 for a
 * read that does not count rows.
 */
function foldOwnKeyGroups<G extends OwnKeyGroup, K>(
  groups: readonly G[],
  keyOf: (g: G) => K
): Array<Omit<G, keyof OwnKeyGroup> & { sums: OwnKeySums }> {
  const folded = new Map<K, Omit<G, keyof OwnKeyGroup> & { sums: OwnKeySums }>();
  for (const g of groups) {
    const { ownKey, _sum, _count, ...fields } = g;
    const spend = _sum.totalCostUsd ?? 0;
    const key = keyOf(g);
    const into = folded.get(key) ?? {
      ...fields,
      sums: { totalCostUsd: 0, ownKeyCostUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 },
    };
    into.sums.totalCostUsd += spend;
    if (ownKey) into.sums.ownKeyCostUsd += spend;
    into.sums.inputTokens += _sum.inputTokens ?? 0;
    into.sums.outputTokens += _sum.outputTokens ?? 0;
    into.sums.count += _count?._all ?? 0;
    folded.set(key, into);
  }
  return [...folded.values()];
}

/** A window's spend grouped by `ownKey`: all of it, and the own-key part. */
function splitByOwnKey(groups: readonly OwnKeyGroup[]): { total: number; ownKey: number } {
  const sums = foldOwnKeyGroups(groups, () => 'window')[0]?.sums;
  return { total: sums?.totalCostUsd ?? 0, ownKey: sums?.ownKeyCostUsd ?? 0 };
}

// ----------------------------------------------------------------------------
// getCostSummary
// ----------------------------------------------------------------------------

interface TrendRow {
  day: Date;
  total_cost_usd: number | string;
  own_key_cost_usd: number | string;
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
  const monthStart = utcMonthStart(now);
  const trendStart = new Date(todayStart.getTime() - 29 * MS_PER_DAY);

  const [todayAgg, weekAgg, monthAgg, byAgentGrouped, byModelGrouped, trendRaw, agentsWithBudget] =
    await Promise.all([
      // By `ownKey`, so each window's own-key part comes from the same read.
      prisma.aiCostLog.groupBy({
        by: ['ownKey'],
        where: { createdAt: { gte: todayStart, lt: tomorrowStart } },
        _sum: { totalCostUsd: true },
      }),
      prisma.aiCostLog.groupBy({
        by: ['ownKey'],
        where: { createdAt: { gte: weekStart, lt: tomorrowStart } },
        _sum: { totalCostUsd: true },
      }),
      prisma.aiCostLog.groupBy({
        by: ['ownKey'],
        where: { createdAt: { gte: monthStart } },
        _sum: { totalCostUsd: true },
      }),
      prisma.aiCostLog.groupBy({
        by: ['agentId'],
        where: { createdAt: { gte: monthStart }, agentId: { not: null } },
        _sum: { totalCostUsd: true },
      }),
      // Grouped by provider as well as model: two providers can serve the same
      // model id, and without the provider the UI can only guess which
      // catalogue entry a spend row belongs to.
      prisma.aiCostLog.groupBy({
        by: ['model', 'provider', 'ownKey'],
        where: { createdAt: { gte: monthStart } },
        _sum: { totalCostUsd: true },
      }),
      prisma.$queryRawUnsafe<TrendRow[]>(
        `
        SELECT
          date_trunc('day', "createdAt") AS day,
          SUM("totalCostUsd") AS total_cost_usd,
          SUM(CASE WHEN "ownKey" THEN "totalCostUsd" ELSE 0 END) AS own_key_cost_usd
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
      const monthSpend = g._sum.totalCostUsd ?? 0;
      // Orphaned cost logs (agent deleted) still surface so
      // sum(byAgent) matches totals.month and the admin isn't confused.
      if (!agent) {
        return {
          agentId: g.agentId,
          name: '(deleted)',
          slug: '(deleted)',
          monthSpend,
          monthlyBudgetUsd: null,
          utilisation: null,
        };
      }
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

  // Split by `ownKey` too, folded back to one row per provider and model.
  const byModel: CostSummaryModelRow[] = foldOwnKeyGroups(
    byModelGrouped,
    (g) => `${g.provider}::${g.model}`
  )
    .map((g) => ({
      model: g.model,
      provider: g.provider,
      monthSpend: g.sums.totalCostUsd,
      ownKeyMonthSpend: g.sums.ownKeyCostUsd,
    }))
    .sort((a, b) => b.monthSpend - a.monthSpend);

  const trend: CostSummaryTrendPoint[] = trendRaw.map((r) => ({
    date: isoDate(r.day),
    totalCostUsd: toNumber(r.total_cost_usd),
    ownKeyCostUsd: toNumber(r.own_key_cost_usd),
  }));

  // Savings is a purely additive signal — any failure here is logged and
  // surfaced as `null` so the rest of the summary renders.
  let localSavings: LocalSavingsResult | null = null;
  try {
    localSavings = await calculateLocalSavings({ dateFrom: monthStart, dateTo: tomorrowStart });
  } catch (err) {
    logger.warn('getCostSummary: calculateLocalSavings threw, returning null savings', {
      error: err instanceof Error ? err.message : String(err),
    });
    localSavings = null;
  }

  const today = splitByOwnKey(todayAgg);
  const week = splitByOwnKey(weekAgg);
  const month = splitByOwnKey(monthAgg);
  return {
    totals: { today: today.total, week: week.total, month: month.total },
    ownKey: { today: today.ownKey, week: week.ownKey, month: month.ownKey },
    byAgent,
    byModel,
    trend,
    localSavings,
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
  const monthStart = utcMonthStart(now);

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

// ----------------------------------------------------------------------------
// getGlobalCapStatus
// ----------------------------------------------------------------------------

/**
 * Check whether the global monthly budget cap (from `AiOrchestrationSettings`)
 * has been exceeded. Returns null cap when no settings row or no cap configured.
 *
 * The spend is every org's on the platform's keys (`getGlobalCapState`; spend
 * on an org's own key is left out), read across orgs at `multi` — the same
 * figure the spend gate enforces against. So it goes only to a
 * caller in the install org (or a system scope), the one place the global cap
 * can be changed (`canChangeSharedSettings`). An admin in a customer org is
 * told whether the cap is reached, since it refuses their org's paid calls
 * too, but not what every org has spent.
 */
export async function getGlobalCapStatus(): Promise<GlobalCapStatus> {
  try {
    const state = await getGlobalCapState();
    return canChangeSharedSettings() ? state : { ...state, spent: null };
  } catch (err) {
    logger.warn('getGlobalCapStatus: failed, returning safe default', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { cap: null, spent: 0, exceeded: false };
  }
}

// ----------------------------------------------------------------------------
// getOrgUsage
// ----------------------------------------------------------------------------

function emptyTotals(): UsageTotals {
  return { totalCostUsd: 0, ownKeyCostUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 };
}

function addTotals(acc: UsageTotals, add: UsageTotals): UsageTotals {
  acc.totalCostUsd += add.totalCostUsd;
  acc.ownKeyCostUsd += add.ownKeyCostUsd;
  acc.inputTokens += add.inputTokens;
  acc.outputTokens += add.outputTokens;
  acc.count += add.count;
  return acc;
}

/** `[start, end)` of a `YYYY-MM` month in UTC. The caller has validated the format. */
export function utcMonthBounds(period: string): { start: Date; end: Date } {
  const [year, month] = period.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

/**
 * Each org's AI usage for one UTC calendar month — the period `checkBudget()`
 * and the org cap use — with its `quotas.monthlyBudgetUsd` beside it (§110
 * t-790). The usage data a fork builds plans and invoices from; plans,
 * pricing and invoices themselves are the fork's.
 *
 * **At `multi` it reads every tenant's spend**, so it runs in the system
 * scope (`runAsSystem`, the audited bypass): inside the caller's org the
 * `org_isolation` policy would hide every other org's rows. Only an
 * install-org caller may be given its answer —
 * `GET /api/v1/admin/orchestration/costs/orgs` is where that is enforced.
 * Rows with no org (an erased org's detached spend) come back as a separate
 * bucket rather than under any org.
 *
 * **At `single` there is one org**, so the answer is one install-org row
 * totalling every row in the month, `NULL`-org legacy rows included, as the
 * global cap counts them.
 */
export async function getOrgUsage(opts: OrgUsageOptions): Promise<OrgUsageReport> {
  const { start, end } = utcMonthBounds(opts.period);
  const multi = isMultiTenant();
  const orgFilter = multi ? opts.orgId : undefined;

  const read = async () => {
    const [grouped, orgs] = await Promise.all([
      prisma.aiCostLog.groupBy({
        by: ['orgId', 'ownKey'],
        where: {
          createdAt: { gte: start, lt: end },
          ...(orgFilter !== undefined ? { orgId: orgFilter } : {}),
        },
        _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
      prisma.org.findMany({
        where: multi ? (orgFilter !== undefined ? { id: orgFilter } : {}) : { id: INSTALL_ORG_ID },
        select: { id: true, name: true, slug: true, status: true, settings: true },
      }),
    ]);
    return { grouped, orgs };
  };

  const { grouped, orgs } = multi
    ? await runAsSystem('org usage rollup (every org spend for one month)', read)
    : await read();

  const byOrg = new Map<string | null, UsageTotals>();
  for (const g of grouped) {
    const spend = g._sum.totalCostUsd ?? 0;
    let totals = byOrg.get(g.orgId);
    if (!totals) {
      totals = emptyTotals();
      byOrg.set(g.orgId, totals);
    }
    addTotals(totals, {
      totalCostUsd: spend,
      ownKeyCostUsd: g.ownKey ? spend : 0,
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      count: g._count._all,
    });
  }

  let detached: UsageTotals | null = null;
  if (multi) {
    // A row naming an org that no longer exists cannot happen (the FK sets it
    // NULL on erasure), but if it did it would be missing from every org row,
    // so it is counted as detached rather than dropped.
    const known = new Set(orgs.map((o) => o.id));
    if (orgFilter === undefined) {
      detached = emptyTotals();
      for (const [orgId, totals] of byOrg) {
        if (orgId === null || !known.has(orgId)) addTotals(detached, totals);
      }
    }
  }

  // At `single` the one org is the install org: asking for any other is asking for none.
  const listed = multi || opts.orgId === undefined ? orgs : orgs.filter((o) => o.id === opts.orgId);
  const rows: OrgUsageRow[] = listed.map((org) => {
    const usage = multi
      ? (byOrg.get(org.id) ?? emptyTotals())
      : [...byOrg.values()].reduce(addTotals, emptyTotals());
    const cap = readOrgQuotas(org.settings, { orgId: org.id }).monthlyBudgetUsd ?? null;
    return {
      orgId: org.id,
      name: org.name,
      slug: org.slug,
      status: org.status,
      ...usage,
      monthlyBudgetUsd: cap,
      // The cap counts the platform's spend only.
      utilisation:
        cap !== null && cap > 0 ? (usage.totalCostUsd - usage.ownKeyCostUsd) / cap : null,
    };
  });
  // By the platform's spend, the figure the table shows and the cap counts.
  const platform = (r: UsageTotals) => r.totalCostUsd - r.ownKeyCostUsd;
  rows.sort((a, b) => platform(b) - platform(a) || a.name.localeCompare(b.name));

  const totals = rows.reduce<UsageTotals>((acc, r) => addTotals(acc, r), emptyTotals());
  if (detached) addTotals(totals, detached);

  return {
    period: opts.period,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    orgs: rows,
    detached,
    totals,
  };
}
