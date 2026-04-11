'use client';

/**
 * CostSummaryCards — 4-card grid at the top of the costs page.
 *
 * Today / This week / This month / Projected month. Projected is
 * derived client-side from `month / daysElapsed * daysInMonth` so a
 * new `/costs/summary` field isn't required for this purely-UI metric.
 *
 * All values null-safe: a missing summary renders `—` in every card
 * rather than throwing, matching the dashboard stats-cards posture.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Usd } from '@/components/admin/orchestration/costs/usd';
import type { CostSummary } from '@/lib/orchestration/llm/cost-reports';

export interface CostSummaryCardsProps {
  summary: CostSummary | null;
  /** Inject `now` in tests so the projection is deterministic. */
  now?: Date;
}

function projectedMonth(monthSpend: number, now: Date): number {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (dayOfMonth <= 0) return monthSpend;
  return (monthSpend / dayOfMonth) * daysInMonth;
}

export function CostSummaryCards({ summary, now }: CostSummaryCardsProps) {
  const today = summary?.totals.today ?? null;
  const week = summary?.totals.week ?? null;
  const month = summary?.totals.month ?? null;
  const effectiveNow = now ?? new Date();
  const projected =
    summary && Number.isFinite(month ?? NaN) && (month ?? 0) >= 0
      ? projectedMonth(month ?? 0, effectiveNow)
      : null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="cost-summary-cards">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">Today</CardTitle>
        </CardHeader>
        <CardContent>
          <Usd value={today} className="text-2xl font-semibold" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">This week</CardTitle>
        </CardHeader>
        <CardContent>
          <Usd value={week} className="text-2xl font-semibold" />
          <p className="text-muted-foreground mt-1 text-xs">Rolling 7 days (UTC)</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">This month</CardTitle>
        </CardHeader>
        <CardContent>
          <Usd value={month} className="text-2xl font-semibold" />
          <p className="text-muted-foreground mt-1 text-xs">Since the 1st (UTC)</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground flex items-center gap-1 text-sm font-medium">
            Projected month
            <FieldHelp title="Projected month-end spend">
              <p>
                Extrapolates the current month-to-date spend to the end of the month using a simple
                per-day run rate: <code>month ÷ days elapsed × days in month</code>.
              </p>
              <p>
                Treat this as a rough forecast. It assumes traffic stays constant and does not
                account for weekend or time-of-day patterns.
              </p>
            </FieldHelp>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Usd value={projected} className="text-2xl font-semibold" />
        </CardContent>
      </Card>
    </div>
  );
}
