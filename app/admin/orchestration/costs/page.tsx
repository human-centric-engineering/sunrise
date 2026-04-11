import type { Metadata } from 'next';

import { CostsView } from '@/components/admin/orchestration/costs/costs-view';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { BudgetAlert, CostSummary } from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';
import type { AiAgent } from '@/types/prisma';
import type { OrchestrationSettings } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Costs & Budget · AI Orchestration',
  description: 'Spend, trends, per-agent utilisation, and orchestration settings.',
};

/**
 * Admin Orchestration — Costs & Budget page (Phase 4 Session 4.4)
 *
 * Thin async server component. Fires every required fetch in parallel,
 * null-safe on each one, and hands the results off to the `<CostsView>`
 * client island for the interactive bits (chart tooltips, pause-agent
 * optimistic updates, settings form state).
 *
 * Data sources:
 *   - `/costs/summary`      → today/week/month totals, byAgent, byModel, trend, localSavings
 *   - `/costs/alerts`       → warning/critical budget alerts
 *   - `/costs?groupBy=model` → 30-day per-model rows for client-side tier synthesis
 *   - `/models`             → model registry (tier + local badge)
 *   - `/agents?limit=100`   → agent list for the per-agent table
 *   - `/settings`           → singleton for the Configuration form
 *
 * Every fetch is wrapped so that an upstream failure renders an empty
 * state rather than throwing. This mirrors `app/admin/orchestration/page.tsx`.
 */

async function getCostSummary(): Promise<CostSummary | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.COSTS_SUMMARY);
    if (!res.ok) return null;
    const body = await parseApiResponse<CostSummary>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('costs page: failed to load cost summary', err);
    return null;
  }
}

async function getBudgetAlerts(): Promise<BudgetAlert[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.COSTS_ALERTS);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ alerts: BudgetAlert[] }>(res);
    return body.success ? body.data.alerts : null;
  } catch (err) {
    logger.error('costs page: failed to load budget alerts', err);
    return null;
  }
}

interface PerModelDaily {
  key: string;
  totalCostUsd: number;
}

async function getPerModel30Day(): Promise<PerModelDaily[] | null> {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    const dateFrom = from.toISOString().slice(0, 10);
    const dateTo = now.toISOString().slice(0, 10);
    const res = await serverFetch(
      `${API.ADMIN.ORCHESTRATION.COSTS}?groupBy=model&dateFrom=${dateFrom}&dateTo=${dateTo}`
    );
    if (!res.ok) return null;
    const body = await parseApiResponse<{
      rows: PerModelDaily[];
      groupBy: string;
    }>(res);
    return body.success ? body.data.rows : null;
  } catch (err) {
    logger.error('costs page: failed to load per-model breakdown', err);
    return null;
  }
}

async function getModels(): Promise<ModelInfo[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.MODELS);
    if (!res.ok) return null;
    const body = await parseApiResponse<{ models: ModelInfo[] }>(res);
    return body.success ? body.data.models : null;
  } catch (err) {
    logger.error('costs page: failed to load models', err);
    return null;
  }
}

async function getAgents(): Promise<AiAgent[] | null> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=100`);
    if (!res.ok) return null;
    const body = await parseApiResponse<AiAgent[]>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('costs page: failed to load agents', err);
    return null;
  }
}

async function getSettings(): Promise<OrchestrationSettings | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.SETTINGS);
    if (!res.ok) return null;
    const body = await parseApiResponse<OrchestrationSettings>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('costs page: failed to load settings', err);
    return null;
  }
}

export default async function CostsPage() {
  const [summary, alerts, perModel, models, agents, settings] = await Promise.all([
    getCostSummary(),
    getBudgetAlerts(),
    getPerModel30Day(),
    getModels(),
    getAgents(),
    getSettings(),
  ]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Costs &amp; Budget</h1>
        <p className="text-muted-foreground text-sm">
          Spend for the rolling month, per-agent utilisation, and orchestration defaults.
        </p>
      </header>

      <CostsView
        summary={summary}
        alerts={alerts}
        perModel={perModel}
        models={models}
        agents={agents}
        settings={settings}
      />
    </div>
  );
}
