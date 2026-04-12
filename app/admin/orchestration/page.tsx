import type { Metadata } from 'next';
import type { AiConversation, AiWorkflowExecution } from '@prisma/client';

import { BudgetAlertsBanner } from '@/components/admin/orchestration/budget-alerts-banner';
import { CostTrendChart } from '@/components/admin/orchestration/costs/cost-trend-chart';
import { ObservabilityStatsCards } from '@/components/admin/orchestration/observability-stats-cards';
import { OrchestrationStatsCards } from '@/components/admin/orchestration/orchestration-stats-cards';
import { QuickActions } from '@/components/admin/orchestration/quick-actions';
import {
  RecentActivityList,
  type RecentActivityItem,
} from '@/components/admin/orchestration/recent-activity-list';
import {
  RecentErrorsPanel,
  type RecentError,
} from '@/components/admin/orchestration/recent-errors-panel';
import { SetupWizardLauncher } from '@/components/admin/orchestration/setup-wizard-launcher';
import {
  TopCapabilitiesPanel,
  type CapabilityUsage,
} from '@/components/admin/orchestration/top-capabilities-panel';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { BudgetAlert, CostSummary } from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

export const metadata: Metadata = {
  title: 'AI Orchestration',
  description: 'Overview of agents, workflows, costs, and recent activity.',
};

/**
 * Admin Orchestration dashboard (Phase 4 Session 4.1)
 *
 * Thin server component that fetches a handful of summary endpoints in
 * parallel and lays them out as four stats cards, a budget-alerts strip,
 * a quick-actions row, and a recent-activity feed. Every fetch is
 * `null`-safe — an API failure renders an empty state instead of
 * throwing, matching `app/admin/overview/page.tsx`.
 *
 * Any feature that needs client interactivity (the Setup Guide wizard)
 * lives in a small client island; the rest is fully server-rendered.
 */

/**
 * Type guard: is this `meta` object a pagination meta with a numeric `total`?
 *
 * `APIResponse.meta` is typed as `PaginationMeta | Record<string, unknown>`,
 * so we narrow at the read site instead of asserting.
 */
function hasNumericTotal(meta: unknown): meta is { total: number } {
  return (
    typeof meta === 'object' &&
    meta !== null &&
    'total' in meta &&
    typeof (meta as { total: unknown }).total === 'number'
  );
}

async function getCostSummary(): Promise<CostSummary | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.COSTS_SUMMARY);
    if (!res.ok) return null;
    const body = await parseApiResponse<CostSummary>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('orchestration dashboard: failed to load cost summary', err);
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
    logger.error('orchestration dashboard: failed to load budget alerts', err);
    return null;
  }
}

async function getPaginatedTotal(path: string): Promise<number | null> {
  try {
    const res = await serverFetch(`${path}?page=1&limit=1`);
    if (!res.ok) return null;
    const body = await parseApiResponse<unknown[]>(res);
    if (!body.success) return null;
    return hasNumericTotal(body.meta) ? body.meta.total : 0;
  } catch (err) {
    logger.error('orchestration dashboard: failed to load count', err, { path });
    return null;
  }
}

async function getRecentActivity(): Promise<RecentActivityItem[] | null> {
  try {
    const [conversationsRes, executionsRes] = await Promise.all([
      serverFetch(`${API.ADMIN.ORCHESTRATION.CONVERSATIONS}?page=1&limit=10`),
      serverFetch(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?page=1&limit=10`),
    ]);

    const conversations: AiConversation[] = conversationsRes.ok
      ? await readPaginatedOrEmpty<AiConversation>(conversationsRes)
      : [];
    // Executions endpoint is a 501 stub until Session 5.2 — treat any
    // non-200 response as an empty list rather than surfacing an error.
    const executions: AiWorkflowExecution[] = executionsRes.ok
      ? await readPaginatedOrEmpty<AiWorkflowExecution>(executionsRes)
      : [];

    const items: RecentActivityItem[] = [
      ...conversations.map(
        (c): RecentActivityItem => ({
          kind: 'conversation',
          id: c.id,
          title: c.title ?? 'Untitled conversation',
          timestamp: (c.updatedAt ?? c.createdAt).toString(),
          href: `/admin/orchestration/conversations/${c.id}`,
        })
      ),
      ...executions.map(
        (e): RecentActivityItem => ({
          kind: 'execution',
          id: e.id,
          title: `Execution ${e.id.slice(0, 8)}`,
          subtitle: e.status,
          timestamp: (
            (e as { updatedAt?: Date; createdAt: Date }).updatedAt ?? e.createdAt
          ).toString(),
          href: `/admin/orchestration/executions/${e.id}`,
        })
      ),
    ];

    // Merge + sort newest-first. Invalid timestamps sort to the bottom.
    items.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });

    return items;
  } catch (err) {
    logger.error('orchestration dashboard: failed to load recent activity', err);
    return null;
  }
}

interface DashboardStats {
  activeConversations: number;
  todayRequests: number;
  errorRate: number;
  recentErrors: RecentError[];
  topCapabilities: CapabilityUsage[];
}

async function getDashboardStats(): Promise<DashboardStats | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.OBSERVABILITY_DASHBOARD_STATS);
    if (!res.ok) return null;
    const body = await parseApiResponse<DashboardStats>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('orchestration dashboard: failed to load observability stats', err);
    return null;
  }
}

async function getModels(): Promise<ModelInfo[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.MODELS);
    if (!res.ok) return null;
    const body = await parseApiResponse<ModelInfo[]>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('orchestration dashboard: failed to load models', err);
    return null;
  }
}

async function readPaginatedOrEmpty<T>(res: Response): Promise<T[]> {
  try {
    const body = await parseApiResponse<T[]>(res);
    return body.success ? body.data : [];
  } catch {
    return [];
  }
}

export default async function OrchestrationDashboardPage() {
  const [
    costSummary,
    budgetAlerts,
    agentsCount,
    workflowsCount,
    conversationsCount,
    activity,
    dashboardStats,
    models,
  ] = await Promise.all([
    getCostSummary(),
    getBudgetAlerts(),
    getPaginatedTotal(API.ADMIN.ORCHESTRATION.AGENTS),
    getPaginatedTotal(API.ADMIN.ORCHESTRATION.WORKFLOWS),
    getPaginatedTotal(API.ADMIN.ORCHESTRATION.CONVERSATIONS),
    getRecentActivity(),
    getDashboardStats(),
    getModels(),
  ]);

  const todayCostUsd = costSummary?.totals.today ?? null;

  // Slice the 30-day trend to last 7 days for the dashboard chart.
  const weekTrend = costSummary?.trend.slice(-7) ?? null;

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">AI Orchestration</h1>
          <p className="text-muted-foreground text-sm">
            Overview of agents, workflows, cost, and recent activity.
          </p>
        </div>
        <SetupWizardLauncher />
      </header>

      <section aria-label="Summary statistics">
        <OrchestrationStatsCards
          agentsCount={agentsCount}
          workflowsCount={workflowsCount}
          todayCostUsd={todayCostUsd}
          conversationsCount={conversationsCount}
        />
      </section>

      <BudgetAlertsBanner alerts={budgetAlerts} />

      <section aria-label="Observability">
        <ObservabilityStatsCards
          activeConversations={dashboardStats?.activeConversations ?? null}
          todayRequests={dashboardStats?.todayRequests ?? null}
          errorRate={dashboardStats?.errorRate ?? null}
        />
      </section>

      <section aria-label="Trends and capabilities" className="grid gap-4 lg:grid-cols-2">
        <CostTrendChart
          title="7-day spend trend"
          trend={weekTrend}
          perModel={null}
          models={models}
        />
        <TopCapabilitiesPanel capabilities={dashboardStats?.topCapabilities ?? null} />
      </section>

      <section aria-label="Recent errors">
        <RecentErrorsPanel errors={dashboardStats?.recentErrors ?? null} />
      </section>

      <section aria-label="Quick actions" className="space-y-2">
        <h2 className="text-lg font-semibold">Quick actions</h2>
        <QuickActions />
      </section>

      <section aria-label="Recent activity">
        <RecentActivityList items={activity} />
      </section>
    </div>
  );
}
