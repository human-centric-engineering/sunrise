import type { Metadata } from 'next';

import { CostsView } from '@/components/admin/orchestration/costs/costs-view';
import { FieldHelp } from '@/components/ui/field-help';
import { logger } from '@/lib/logging';
import {
  getCostSummary as fetchCostSummary,
  getBudgetAlerts as fetchBudgetAlerts,
  getCostBreakdown,
} from '@/lib/orchestration/llm/cost-reports';
import { getAvailableModels } from '@/lib/orchestration/llm/model-registry';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';

export const metadata: Metadata = {
  title: 'Costs & Budget · AI Orchestration',
  description: 'Spend, trends, per-agent utilisation, and orchestration settings.',
};

export default async function CostsPage() {
  const now = new Date();
  const from = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);

  const [summary, alerts, perModelResult, models, settings] = await Promise.all([
    fetchCostSummary().catch((err) => {
      logger.error('costs page: failed to load cost summary', err);
      return null;
    }),
    fetchBudgetAlerts().catch((err) => {
      logger.error('costs page: failed to load budget alerts', err);
      return null;
    }),
    getCostBreakdown({ dateFrom: from, dateTo: now, groupBy: 'model' }).catch((err) => {
      logger.error('costs page: failed to load per-model breakdown', err);
      return null;
    }),
    Promise.resolve(getAvailableModels()).catch(() => null),
    getOrchestrationSettings().catch((err) => {
      logger.error('costs page: failed to load settings', err);
      return null;
    }),
  ]);

  const perModel = perModelResult?.rows ?? null;

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

      <CostsView
        summary={summary}
        alerts={alerts}
        perModel={perModel}
        models={models}
        settings={settings}
      />
    </div>
  );
}
