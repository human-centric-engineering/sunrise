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
 *   5. Per-org table       — only with more than one org, or erased orgs' spend
 *   6. Local vs cloud panel
 *
 * The default-models form used to live here too; it now lives on the
 * Settings page where developers actually look for it. A small footer
 * link below points there.
 *
 * An org viewer (§111 t-812) sees their org's spend and none of the
 * platform-ops half: no per-org table and no link to the global budget
 * settings, neither of which they may use.
 *
 * `alerts: null` means the budget alerts failed to load: `<LoadFailedNotice>`
 * takes the alerts panel's place, because its empty state ("No agents are
 * currently over 80% of their monthly budget") would read as an all-clear
 * (#518). The other panels still render.
 */

import Link from 'next/link';
import { Settings as SettingsIcon } from 'lucide-react';

import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { BudgetAlertsList } from '@/components/admin/orchestration/costs/budget-alerts-list';
import { CostMethodology } from '@/components/admin/orchestration/costs/cost-methodology';
import { CostSummaryCards } from '@/components/admin/orchestration/costs/cost-summary-cards';
import { CostTrendChart } from '@/components/admin/orchestration/costs/cost-trend-chart';
import { LocalVsCloudPanel } from '@/components/admin/orchestration/costs/local-vs-cloud-panel';
import { PerAgentCostTable } from '@/components/admin/orchestration/costs/per-agent-cost-table';
import { PerModelBreakdownTable } from '@/components/admin/orchestration/costs/per-model-breakdown-table';
import { PerOrgUsageTable } from '@/components/admin/orchestration/costs/per-org-usage-table';
import { PricingReference } from '@/components/admin/orchestration/costs/pricing-reference';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { AdminViewerTier } from '@/lib/auth/admin-tier';
import type {
  BudgetAlert,
  CostSummary,
  GlobalCapStatus,
  OrgUsageReport,
} from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

interface PerModelDaily {
  key: string;
  totalCostUsd: number;
}

export interface CostsViewProps {
  summary: CostSummary | null;
  /**
   * Agents at or over 80% of their monthly budget. `null` means it failed to
   * load: the alerts panel shows a notice instead of "no agents over budget".
   */
  alerts: BudgetAlert[] | null;
  /** The global cap's state, from the same load as `alerts`. */
  globalCap: GlobalCapStatus | null;
  perModel: PerModelDaily[] | null;
  models: ModelInfo[] | null;
  /** Epoch ms when OpenRouter pricing was last fetched. null/0 = static fallback. */
  registryFetchedAt?: number | null;
  /**
   * Each org's spend this month. `null` when it could not be loaded, or the
   * caller is outside the install org at `multi` (the endpoint refuses them).
   */
  orgUsage?: OrgUsageReport | null;
  /** Who is viewing: an org viewer gets no platform-ops section. Defaults to the platform. */
  viewerTier?: AdminViewerTier;
}

export function CostsView({
  summary,
  alerts,
  globalCap,
  perModel,
  models,
  registryFetchedAt,
  orgUsage,
  viewerTier = 'platform',
}: CostsViewProps) {
  const platform = viewerTier === 'platform';
  return (
    <div className="space-y-8">
      <CostSummaryCards summary={summary} />

      {alerts ? (
        <BudgetAlertsList alerts={alerts} globalCap={globalCap} />
      ) : (
        <LoadFailedNotice what="budget alerts" />
      )}

      <CostTrendChart trend={summary?.trend ?? null} perModel={perModel} models={models} />

      <div className="grid gap-6 lg:grid-cols-2">
        <PerAgentCostTable rows={summary?.byAgent ?? null} />
        <PerModelBreakdownTable rows={summary?.byModel ?? null} models={models} />
      </div>

      {platform &&
        orgUsage &&
        (orgUsage.orgs.length > 1 || (orgUsage.detached?.count ?? 0) > 0) && (
          <PerOrgUsageTable report={orgUsage} />
        )}

      <LocalVsCloudPanel summary={summary} models={models} />

      <PricingReference
        models={models}
        fetchedAt={registryFetchedAt ?? null}
        canForceRefresh={platform}
      />

      <CostMethodology />

      {platform && (
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
                  Configure the per-task default models and the global monthly budget on the
                  Settings page.
                </p>
              </div>
            </div>
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <Link href="/admin/orchestration/settings">Open Settings</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
