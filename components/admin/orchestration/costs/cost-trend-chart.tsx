'use client';

/**
 * CostTrendChart — 30-day stacked-area chart by tier.
 *
 * The `/costs/summary.trend` endpoint only returns total spend per day,
 * not per-tier. To render the stacked breakdown the spec asks for, the
 * page fetches `/costs?groupBy=model&dateFrom=…&dateTo=…` in parallel
 * and we bucket model→tier client-side against the `/models` response
 * ("tier synthesis" — documented in `.context/admin/orchestration-costs.md`).
 *
 * When the per-model data is missing (upstream error) we fall back to
 * rendering the raw total trend as a single area so the chart still
 * shows *something* useful.
 *
 * It plots the platform's spend, as the cards beside it show it: each day's
 * total and each model's weight in the tier split leave out spend on orgs'
 * own keys, which the vendor bills to the org (§137 t-1058).
 */

import * as React from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Usd } from '@/components/admin/orchestration/costs/usd';
import { formatUsd } from '@/lib/utils/format-currency';
import type { CostBreakdownRow, CostSummaryTrendPoint } from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

/** The fields of a `/costs?groupBy=model` row the chart reads. */
export type PerModelRow = Pick<CostBreakdownRow, 'key' | 'totalCostUsd' | 'ownKeyCostUsd'>;

export interface CostTrendChartProps {
  trend: CostSummaryTrendPoint[] | null;
  /** Rows from `/costs?groupBy=model&dateFrom=...&dateTo=...`. */
  perModel: PerModelRow[] | null;
  models: ModelInfo[] | null;
  /** Override the card title. Defaults to "30-day spend trend". */
  title?: string;
  /**
   * How many UTC days, ending today, the chart plots and its own-key line
   * sums. Defaults to 30. Points outside it are left out: `trend` omits days
   * with no spend, so its last N points can reach further back than N days.
   */
  days?: number;
}

interface PlotRow {
  date: string;
  budget: number;
  mid: number;
  frontier: number;
  local: number;
  total: number;
}

const TIER_COLOURS: Record<'budget' | 'mid' | 'frontier' | 'local', string> = {
  budget: '#60a5fa', // blue-400
  mid: '#34d399', // emerald-400
  frontier: '#f472b6', // pink-400
  local: '#a78bfa', // violet-400
};

/**
 * Generate the full `days`-day date range, filling in zero-spend days that
 * the API omits. This prevents the chart from drawing misleading lines
 * across gaps where no spend occurred. Points before the range are left out.
 */
function fillZeroDays(trend: CostSummaryTrendPoint[], days: number): CostSummaryTrendPoint[] {
  if (trend.length === 0) return [];

  const byDate = new Map(trend.map((pt) => [pt.date, pt]));

  // Build the full range ending today (UTC)
  const now = new Date();
  const result: CostSummaryTrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const date = d.toISOString().slice(0, 10);
    result.push(byDate.get(date) ?? { date, totalCostUsd: 0, ownKeyCostUsd: 0 });
  }
  return result;
}

function buildPlotRows(
  trendList: CostSummaryTrendPoint[],
  perModel: PerModelRow[] | null,
  models: ModelInfo[] | null
): PlotRow[] {
  if (trendList.length === 0) return [];

  // `perModel` comes from `/costs?groupBy=model`, whose rows carry a bare model
  // id and no provider — so unlike the summary's `byModel` (#436) we can't key
  // this lookup by provider. First-write-wins is the best available guard: the
  // static registry is merged ahead of DB-only rows, so a seeded example row
  // under a second provider can't displace the real entry for a shared id.
  const tierByModel = new Map<string, 'budget' | 'mid' | 'frontier' | 'local'>();
  for (const m of models ?? []) {
    if (!tierByModel.has(m.id)) tierByModel.set(m.id, m.tier);
  }

  // If perModel data is available, proportionally split each day's
  // total by the 30-day tier distribution. This is not perfect
  // (tier mix may drift day to day) but it is the best we can do
  // without a per-day-per-tier endpoint.
  const tierTotals = { budget: 0, mid: 0, frontier: 0, local: 0 };
  for (const row of perModel ?? []) {
    const tier = tierByModel.get(row.key);
    if (!tier) continue;
    tierTotals[tier] += row.totalCostUsd - row.ownKeyCostUsd;
  }
  const tierSum = tierTotals.budget + tierTotals.mid + tierTotals.frontier + tierTotals.local;

  return trendList.map((pt) => {
    const total = pt.totalCostUsd - pt.ownKeyCostUsd;
    if (tierSum > 0 && total > 0) {
      return {
        date: pt.date,
        budget: (total * tierTotals.budget) / tierSum,
        mid: (total * tierTotals.mid) / tierSum,
        frontier: (total * tierTotals.frontier) / tierSum,
        local: (total * tierTotals.local) / tierSum,
        total,
      };
    }
    // Zero-spend day or no tier data: all zeros
    if (total === 0) {
      return { date: pt.date, budget: 0, mid: 0, frontier: 0, local: 0, total: 0 };
    }
    // Fallback: attribute all spend to a single "total" bucket via `mid`.
    return {
      date: pt.date,
      budget: 0,
      mid: total,
      frontier: 0,
      local: 0,
      total,
    };
  });
}

export function CostTrendChart({
  trend,
  perModel,
  models,
  title = '30-day spend trend',
  days = 30,
}: CostTrendChartProps) {
  const inWindow = React.useMemo(() => fillZeroDays(trend ?? [], days), [trend, days]);
  const data = React.useMemo(
    () => buildPlotRows(inWindow, perModel, models),
    [inWindow, perModel, models]
  );
  // Left out of every point above, and said so below the chart.
  const ownKeyTotal = React.useMemo(
    () => inWindow.reduce((sum, pt) => sum + pt.ownKeyCostUsd, 0),
    [inWindow]
  );

  return (
    <Card data-testid="cost-trend-chart">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 || data.every((d) => d.total === 0) ? (
          <p className="text-muted-foreground py-12 text-center text-sm">
            {ownKeyTotal > 0
              ? "No spend on the platform's keys in this period."
              : `No spend recorded in the last ${days} days.`}
          </p>
        ) : (
          <div className="h-72 w-full" role="img" aria-label={`${title} by tier`}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => formatUsd(v, { compact: true })}
                />
                <Tooltip
                  formatter={(value, name) => [
                    formatUsd(typeof value === 'number' ? value : Number(value) || 0),
                    String(name ?? ''),
                  ]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="budget"
                  stackId="tier"
                  stroke={TIER_COLOURS.budget}
                  fill={TIER_COLOURS.budget}
                  name="Budget"
                />
                <Area
                  type="monotone"
                  dataKey="mid"
                  stackId="tier"
                  stroke={TIER_COLOURS.mid}
                  fill={TIER_COLOURS.mid}
                  name="Mid"
                />
                <Area
                  type="monotone"
                  dataKey="frontier"
                  stackId="tier"
                  stroke={TIER_COLOURS.frontier}
                  fill={TIER_COLOURS.frontier}
                  name="Frontier"
                />
                <Area
                  type="monotone"
                  dataKey="local"
                  stackId="tier"
                  stroke={TIER_COLOURS.local}
                  fill={TIER_COLOURS.local}
                  name="Local"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        {ownKeyTotal > 0 && (
          <p className="text-muted-foreground mt-2 text-xs" data-testid="trend-own-key-spend">
            Leaves out <Usd value={ownKeyTotal} /> on organisations&apos; own keys in this period
          </p>
        )}
      </CardContent>
    </Card>
  );
}
