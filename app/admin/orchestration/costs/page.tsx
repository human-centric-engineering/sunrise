import type { Metadata } from 'next';

import { CostsView } from '@/components/admin/orchestration/costs/costs-view';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { adminPageViewerTier } from '@/lib/auth/admin-page-viewer';
import { loadServerData, requireServerData, type LoadResult } from '@/lib/api/server-load';
import { refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';
import type {
  BudgetAlert,
  CostSummary,
  GlobalCapStatus,
  OrgUsageReport,
} from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

export const metadata: Metadata = {
  title: 'Costs & Budget · AI Orchestration',
  description: 'Spend, trends, per-agent utilisation, and orchestration settings.',
};

/**
 * Admin Orchestration — Costs & Budget page (Phase 4 Session 4.4)
 *
 * Thin async server component. Fires every fetch in parallel and hands the results off to the `<CostsView>`
 * client island for the interactive bits (chart tooltips, pause-agent
 * optimistic updates, settings form state).
 *
 * Data sources:
 *   - `/costs/summary`      → today/week/month totals, byAgent, byModel, trend, localSavings
 *   - `/costs/alerts`       → warning/critical budget alerts
 *   - `/costs?groupBy=model` → 30-day per-model rows for client-side tier synthesis
 *   - `/models`             → model registry (tier + local badge)
 *   - `/settings`           → singleton for the Configuration form
 *   - `/costs/orgs`         → each org's spend this month against its cap (shown
 *                             only with more than one org; refused outside the
 *                             install org at `multi`, which hides the table)
 *
 * An org admin (§111 t-812) gets their org's half: every figure above is
 * `AiCostLog` read in the entered org, so it is already theirs. The
 * platform-ops half — each org's usage and the settings card for the global
 * budget — is not fetched or rendered for them, and its routes refuse them.
 *
 * A failed load never renders as an empty state (#518). The summary is the
 * page's main data — it feeds the totals, the trend, both breakdown tables
 * and the local-vs-cloud panel, and `<CostsView>` renders a missing one as
 * "no spend" — so its failure throws to the error boundary. The budget
 * alerts reach the view as `null` when they fail, and it shows
 * `<LoadFailedNotice>` in the alerts panel's place rather than "no agents
 * over budget". The per-model breakdown, the model registry and the per-org
 * table are panels the page can live without: each failure shows
 * `<LoadFailedNotice>` above the view. A 403 from `/costs/orgs` is the
 * expected refusal described above and hides the table without a notice.
 */

interface AlertsResponse {
  alerts: BudgetAlert[];
  globalCap: GlobalCapStatus;
}

interface PerModelDaily {
  key: string;
  totalCostUsd: number;
}

async function getPerModel30Day(): Promise<LoadResult<{ rows: PerModelDaily[]; groupBy: string }>> {
  const now = new Date();
  const from = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  const dateFrom = from.toISOString().slice(0, 10);
  const dateTo = now.toISOString().slice(0, 10);
  return loadServerData<{ rows: PerModelDaily[]; groupBy: string }>(
    `${API.ADMIN.ORCHESTRATION.COSTS}?groupBy=model&dateFrom=${dateFrom}&dateTo=${dateTo}`
  );
}

interface ModelsResponse {
  models: ModelInfo[];
  fetchedAt: number;
}

/** A refusal (403) is the expected answer outside the install org at `multi`. */
function isRefusal(result: LoadResult<unknown>): boolean {
  return !result.ok && result.failure.kind === 'failed' && result.failure.status === 403;
}

export default async function CostsPage() {
  // Ensure model pricing is current before rendering. No-op if cache
  // is fresh (< 24h); only hits OpenRouter when stale or on cold start.
  const [, viewerTier] = await Promise.all([refreshFromOpenRouter(), adminPageViewerTier()]);
  const platform = viewerTier === 'platform';

  // Settings are no longer needed here — the default-models form moved
  // to the Settings page; the Costs page keeps a footer link to it.
  const [{ data: summary }, alertsResponse, perModel, modelsResponse, orgUsage] = await Promise.all(
    [
      requireServerData<CostSummary>(API.ADMIN.ORCHESTRATION.COSTS_SUMMARY),
      loadServerData<AlertsResponse>(API.ADMIN.ORCHESTRATION.COSTS_ALERTS),
      getPerModel30Day(),
      loadServerData<ModelsResponse>(API.ADMIN.ORCHESTRATION.MODELS),
      platform
        ? loadServerData<OrgUsageReport>(API.ADMIN.ORCHESTRATION.COSTS_ORGS, {
            // Refused outside the install org at `multi`: hidden, not logged.
            expected: [403],
          })
        : null,
    ]
  );

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">
          Costs &amp; Budget{' '}
          <FieldHelp
            title="What is costs & budget?"
            contentClassName="w-96 max-h-80 overflow-y-auto"
          >
            <p>
              This tracks the dollar cost of every LLM API call your agents and workflows make. It
              aggregates spending by agent, model, and time period so you can see where your AI
              budget goes.
            </p>
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              Each API call records the token count and the model&apos;s per-token price. The system
              totals these into daily, weekly, and monthly figures. Budget alerts fire when spending
              crosses warning or critical thresholds you configure.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              View spend trends, per-agent and per-model breakdowns, configure alert thresholds, and
              set default budget caps for new agents.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Spend for the rolling month, per-agent utilisation, and orchestration defaults.
        </p>
      </header>

      {!perModel.ok && <LoadFailedNotice what="the per-model spend breakdown" />}
      {!modelsResponse.ok && <LoadFailedNotice what="the model registry" />}
      {orgUsage && !orgUsage.ok && !isRefusal(orgUsage) && (
        <LoadFailedNotice what="per-organisation usage" />
      )}

      <CostsView
        summary={summary}
        alerts={alertsResponse.ok ? alertsResponse.data.alerts : null}
        globalCap={alertsResponse.ok ? alertsResponse.data.globalCap : null}
        perModel={perModel.ok ? perModel.data.rows : null}
        models={modelsResponse.ok ? modelsResponse.data.models : null}
        registryFetchedAt={modelsResponse.ok ? modelsResponse.data.fetchedAt : null}
        orgUsage={orgUsage?.ok ? orgUsage.data : null}
        viewerTier={viewerTier}
      />
    </div>
  );
}
