import type { Metadata } from 'next';
import type { AiConversation, AiWorkflowExecution } from '@/types/orchestration';

import { BudgetAlertsBanner } from '@/components/admin/orchestration/budget-alerts-banner';
import { CostTrendChart } from '@/components/admin/orchestration/costs/cost-trend-chart';
import {
  DashboardActivityFeed,
  type ActivityFeedItem,
} from '@/components/admin/orchestration/dashboard-activity-feed';
import { DashboardStatsCards } from '@/components/admin/orchestration/dashboard-stats-cards';
import { SetupRequiredBanner } from '@/components/admin/orchestration/setup-required-banner';
import { SetupWizardLauncher } from '@/components/admin/orchestration/setup-wizard-launcher';
import {
  TopCapabilitiesPanel,
  type CapabilityUsage,
} from '@/components/admin/orchestration/top-capabilities-panel';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { BudgetAlert, CostSummary } from '@/lib/orchestration/llm/cost-reports';
import { getSetupState } from '@/lib/orchestration/setup-state';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

export const metadata: Metadata = {
  title: 'AI Orchestration',
  description: 'Overview of agents, costs, and recent activity.',
};

/**
 * Admin Orchestration dashboard.
 *
 * Simplified three-section layout:
 *   1. Stats row — 4 clickable operational metric cards
 *   2. Trends — spend chart + top capabilities (2-col) with activity feed
 *   3. Budget alerts — conditional banner
 *
 * Every fetch is `null`-safe — a failing API renders an empty state,
 * never throws.
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

interface RecentError {
  id: string;
  errorMessage: string | null;
  workflowId: string;
  createdAt: string;
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

/**
 * Build a unified activity feed from conversations, executions, and errors.
 * Items are merged and sorted newest-first.
 */
async function getActivityFeed(
  recentErrors: RecentError[] | null
): Promise<ActivityFeedItem[] | null> {
  try {
    const [conversationsRes, executionsRes] = await Promise.all([
      serverFetch(`${API.ADMIN.ORCHESTRATION.CONVERSATIONS}?page=1&limit=10`),
      serverFetch(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?page=1&limit=10`),
    ]);

    const conversations: AiConversation[] = conversationsRes.ok
      ? await readPaginatedOrEmpty<AiConversation>(conversationsRes)
      : [];
    const executions: AiWorkflowExecution[] = executionsRes.ok
      ? await readPaginatedOrEmpty<AiWorkflowExecution>(executionsRes)
      : [];

    const items: ActivityFeedItem[] = [
      ...conversations.map(
        (c): ActivityFeedItem => ({
          kind: 'conversation',
          id: c.id,
          title: c.title ?? 'Untitled conversation',
          timestamp: (c.updatedAt ?? c.createdAt).toString(),
          href: `/admin/orchestration/conversations/${c.id}`,
        })
      ),
      ...executions.map(
        (e): ActivityFeedItem => ({
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
      ...(recentErrors ?? []).map(
        (err): ActivityFeedItem => ({
          kind: 'error',
          id: err.id,
          title: `Error ${err.id.slice(0, 8)}`,
          subtitle: err.errorMessage ?? 'Unknown error',
          timestamp: err.createdAt,
          href: `/admin/orchestration/executions/${err.id}`,
        })
      ),
    ];

    // Deduplicate: an execution error may appear in both executions and
    // recentErrors. Keep the error variant (more informative).
    const seen = new Set<string>();
    const deduped: ActivityFeedItem[] = [];
    // Process errors first so they win over plain execution entries.
    const sorted = [...items].sort((a, b) => {
      if (a.kind === 'error' && b.kind !== 'error') return -1;
      if (a.kind !== 'error' && b.kind === 'error') return 1;
      return 0;
    });
    for (const item of sorted) {
      const key = item.id;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(item);
      }
    }

    // Sort newest-first. Invalid timestamps sort to the bottom.
    deduped.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });

    return deduped;
  } catch (err) {
    logger.error('orchestration dashboard: failed to load activity feed', err);
    return null;
  }
}

export default async function OrchestrationDashboardPage() {
  const [costSummary, budgetAlerts, agentsCount, dashboardStats, models, setupState] =
    await Promise.all([
      getCostSummary(),
      getBudgetAlerts(),
      getPaginatedTotal(API.ADMIN.ORCHESTRATION.AGENTS),
      getDashboardStats(),
      getModels(),
      getSetupState(),
    ]);

  const todayCostUsd = costSummary?.totals.today ?? null;
  const weekTrend = costSummary?.trend.slice(-7) ?? null;

  // Activity feed merges conversations, executions, and errors.
  const activity = await getActivityFeed(dashboardStats?.recentErrors ?? null);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">AI Orchestration</h1>
          <p className="text-muted-foreground text-sm">
            Operational overview — agents, spend, and activity.
          </p>
        </div>
        <SetupWizardLauncher forceOpen={!setupState.hasProvider} />
      </header>

      <SetupRequiredBanner hasProvider={setupState.hasProvider} />

      <BudgetAlertsBanner alerts={budgetAlerts} />

      <section aria-label="Summary statistics">
        <DashboardStatsCards
          agentsCount={agentsCount}
          todayCostUsd={todayCostUsd}
          todayRequests={dashboardStats?.todayRequests ?? null}
          errorRate={dashboardStats?.errorRate ?? null}
        />
      </section>

      <section aria-label="Trends and activity" className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <CostTrendChart
            title="7-day spend trend"
            trend={weekTrend}
            perModel={null}
            models={models}
          />
          <TopCapabilitiesPanel capabilities={dashboardStats?.topCapabilities ?? null} />
        </div>
        <DashboardActivityFeed items={activity} />
      </section>
    </div>
  );
}
