'use client';

/**
 * CostsView — top-level client island for the costs page.
 *
 * Pure composition. The server shell at
 * `app/admin/orchestration/costs/page.tsx` runs the parallel null-safe
 * fetches and hands the results down as props; this component
 * assembles the sections in the expected visual order and owns
 * nothing beyond layout.
 *
 * Order (top-to-bottom):
 *   1. Summary cards       — Today / Week / Month / Projected
 *   2. Budget alerts list  — pause-agent optimistic action
 *   3. Trend chart         — 30-day stacked by tier
 *   4. Per-agent table + per-model table (2-col on lg)
 *   5. Local vs cloud panel
 *
 * The default-models form used to live here too; it now lives on the
 * Settings page where developers actually look for it. A small footer
 * link below points there.
 */

import Link from 'next/link';
import { Settings as SettingsIcon } from 'lucide-react';

import { BudgetAlertsList } from '@/components/admin/orchestration/costs/budget-alerts-list';
import { CostMethodology } from '@/components/admin/orchestration/costs/cost-methodology';
import { CostSummaryCards } from '@/components/admin/orchestration/costs/cost-summary-cards';
import { CostTrendChart } from '@/components/admin/orchestration/costs/cost-trend-chart';
import { LocalVsCloudPanel } from '@/components/admin/orchestration/costs/local-vs-cloud-panel';
import { PerAgentCostTable } from '@/components/admin/orchestration/costs/per-agent-cost-table';
import { PerModelBreakdownTable } from '@/components/admin/orchestration/costs/per-model-breakdown-table';
import { PricingReference } from '@/components/admin/orchestration/costs/pricing-reference';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type {
  BudgetAlert,
  CostSummary,
  GlobalCapStatus,
} from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

interface PerModelDaily {
  key: string;
  totalCostUsd: number;
}

export interface CostsViewProps {
  summary: CostSummary | null;
  alerts: BudgetAlert[] | null;
  globalCap: GlobalCapStatus | null;
  perModel: PerModelDaily[] | null;
  models: ModelInfo[] | null;
  /** Epoch ms when OpenRouter pricing was last fetched. null/0 = static fallback. */
  registryFetchedAt?: number | null;
}

export function CostsView({
  summary,
  alerts,
  globalCap,
  perModel,
  models,
  registryFetchedAt,
}: CostsViewProps) {
  return (
    <div className="space-y-8">
      <CostSummaryCards summary={summary} />

      <BudgetAlertsList alerts={alerts} globalCap={globalCap} />

      <CostTrendChart trend={summary?.trend ?? null} perModel={perModel} models={models} />

      <div className="grid gap-6 lg:grid-cols-2">
        <PerAgentCostTable rows={summary?.byAgent ?? null} />
        <PerModelBreakdownTable rows={summary?.byModel ?? null} models={models} />
      </div>

      <LocalVsCloudPanel summary={summary} models={models} />

      <PricingReference models={models} fetchedAt={registryFetchedAt ?? null} />

      <CostMethodology />

      <Card>
        <CardContent className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <SettingsIcon
              className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
              aria-hidden="true"
            />
            <div className="text-sm">
              <p className="font-medium">Default models &amp; budget caps</p>
              <p className="text-muted-foreground">
                Configure the per-task default models and the global monthly budget on the Settings
                page.
              </p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <Link href="/admin/orchestration/settings">Open Settings</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
