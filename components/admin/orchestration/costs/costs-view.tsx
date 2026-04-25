'use client';

/**
 * CostsView — top-level client island for the costs page.
 *
 * Pure composition. The server shell at
 * `app/admin/orchestration/costs/page.tsx` runs the six parallel
 * null-safe fetches and hands the results down as props; this
 * component assembles the sections in the expected visual order and
 * owns nothing beyond layout.
 *
 * Order (top-to-bottom):
 *   1. Summary cards       — Today / Week / Month / Projected
 *   2. Budget alerts list  — pause-agent optimistic action
 *   3. Trend chart         — 30-day stacked by tier
 *   4. Per-agent table + per-model table (2-col on lg)
 *   5. Local vs cloud panel
 *   6. Configuration form
 */

import { BudgetAlertsList } from '@/components/admin/orchestration/costs/budget-alerts-list';
import { CostMethodology } from '@/components/admin/orchestration/costs/cost-methodology';
import { CostSummaryCards } from '@/components/admin/orchestration/costs/cost-summary-cards';
import { CostTrendChart } from '@/components/admin/orchestration/costs/cost-trend-chart';
import { LocalVsCloudPanel } from '@/components/admin/orchestration/costs/local-vs-cloud-panel';
import { OrchestrationSettingsForm } from '@/components/admin/orchestration/costs/orchestration-settings-form';
import { PerAgentCostTable } from '@/components/admin/orchestration/costs/per-agent-cost-table';
import { PerModelBreakdownTable } from '@/components/admin/orchestration/costs/per-model-breakdown-table';
import { PricingReference } from '@/components/admin/orchestration/costs/pricing-reference';
import type {
  BudgetAlert,
  CostSummary,
  GlobalCapStatus,
} from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';
import type { OrchestrationSettings } from '@/types/orchestration';

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
  settings: OrchestrationSettings | null;
  /** Epoch ms when OpenRouter pricing was last fetched. null/0 = static fallback. */
  registryFetchedAt?: number | null;
}

export function CostsView({
  summary,
  alerts,
  globalCap,
  perModel,
  models,
  settings,
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

      <OrchestrationSettingsForm settings={settings} models={models} />
    </div>
  );
}
