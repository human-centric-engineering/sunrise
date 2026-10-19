import type { Metadata } from 'next';
import type { AiConversation, AiWorkflowExecution } from '@/types/orchestration';

import {
  ActiveQuarantinesPanel,
  type ActiveQuarantineRow,
} from '@/components/admin/orchestration/active-quarantines-panel';
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
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { adminPageViewerTier } from '@/lib/auth/admin-page-viewer';
import { loadServerData } from '@/lib/api/server-load';
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
 * No single panel is the page's reason to exist, so a failed load never
 * throws: each panel whose data could not be loaded renders
 * `<LoadFailedNotice>` in its place, and the rest of the dashboard works.
 * It matters more here than anywhere: an empty quarantine panel and a
 * missing budget banner are the all-clear signals, so a failure must not
 * look like either (#518). The stat cards show "—" for a figure they could
 * not load, which already reads as unknown rather than zero.
 *
 * An org admin (§111 t-812) sees their org's half: the stats, spend, budget
 * alerts and activity, each read in the entered org. The platform-ops half —
 * the setup wizard and banner (providers and global settings) and the
 * capability quarantines (global config) — is neither fetched nor rendered
 * for them, and its routes refuse them.
 */

function hasNumericTotal(meta: unknown): meta is { total: number } {
  return (
    typeof meta === 'object' && meta !== null && 'total' in meta && typeof meta.total === 'number'
  );
}

/** The loaded value, or `null` when the load failed (`loadServerData` logs it). */
async function loadOrNull<T>(path: string): Promise<T | null> {
  const result = await loadServerData<T>(path);
  return result.ok ? result.data : null;
}

async function getPaginatedTotal(path: string): Promise<number | null> {
  const result = await loadServerData<unknown[]>(
    `${path}${path.includes('?') ? '&' : '?'}page=1&limit=1`
  );
  if (!result.ok) return null;
  return hasNumericTotal(result.meta) ? result.meta.total : 0;
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

/**
 * Capabilities currently in effective quarantine (auto-expiry handled by the
 * API route). `null` when the load failed.
 */
async function getActiveQuarantines(): Promise<ActiveQuarantineRow[] | null> {
  const body = await loadOrNull<{ items: ActiveQuarantineRow[] }>(
    API.ADMIN.ORCHESTRATION.OBSERVABILITY_ACTIVE_QUARANTINES
  );
  if (body === null) return null;
  // A reply without `items` counts as a failed load. Returned as `[]` it
  // would read as "nothing quarantined", the all-clear.
  if (Array.isArray(body.items)) return body.items;
  logger.error('Dashboard: active-quarantines reply has no items list', undefined, {
    path: API.ADMIN.ORCHESTRATION.OBSERVABILITY_ACTIVE_QUARANTINES,
  });
  return null;
}

async function getModels(): Promise<ModelInfo[] | null> {
  // The /models endpoint returns `{ models, refreshed, fetchedAt }` —
  // unwrap to the array. Returning the wrapper object made downstream
  // consumers (e.g. CostTrendChart's `for (const m of models ?? [])`)
  // throw "is not iterable" silently, since `??` only short-circuits
  // null/undefined and the object slipped past the type assertion.
  const body = await loadOrNull<{ models: ModelInfo[] }>(API.ADMIN.ORCHESTRATION.MODELS);
  if (body === null) return null;
  if (Array.isArray(body.models)) return body.models;
  logger.error('Dashboard: models reply has no models list', undefined, {
    path: API.ADMIN.ORCHESTRATION.MODELS,
  });
  return null;
}

/**
 * Build a unified activity feed from conversations, executions, and errors.
 * Items are merged and sorted newest-first. `null` when any of the three
 * sources failed: a feed missing one of them would read as complete.
 */
async function getActivityFeed(
  recentErrorsRead: Promise<RecentError[] | null>
): Promise<ActivityFeedItem[] | null> {
  const [conversations, executions, recentErrors] = await Promise.all([
    loadOrNull<AiConversation[]>(`${API.ADMIN.ORCHESTRATION.CONVERSATIONS}?page=1&limit=10`),
    loadOrNull<AiWorkflowExecution[]>(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?page=1&limit=10`),
    recentErrorsRead,
  ]);
  if (conversations === null || executions === null || recentErrors === null) return null;

  const items: ActivityFeedItem[] = [
    ...conversations.map((c): ActivityFeedItem => ({
      kind: 'conversation',
      id: c.id,
      title: c.title ?? 'Untitled conversation',
      timestamp: (c.updatedAt ?? c.createdAt).toString(),
      href: `/admin/orchestration/conversations/${c.id}`,
    })),
    ...executions.map((e): ActivityFeedItem => ({
      kind: 'execution',
      id: e.id,
      title: `Execution ${e.id.slice(0, 8)}`,
      subtitle: e.status,
      timestamp: ((e as { updatedAt?: Date; createdAt: Date }).updatedAt ?? e.createdAt).toString(),
      href: `/admin/orchestration/executions/${e.id}`,
    })),
    ...recentErrors.map((err): ActivityFeedItem => ({
      kind: 'error',
      id: err.id,
      title: `Error ${err.id.slice(0, 8)}`,
      subtitle: err.errorMessage ?? 'Unknown error',
      timestamp: err.createdAt,
      href: `/admin/orchestration/executions/${err.id}`,
    })),
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
}

export default async function OrchestrationDashboardPage() {
  // Started alongside the fetches; only the platform-ops two wait on it.
  const platformRead = adminPageViewerTier().then((tier) => tier === 'platform');
  // Shared with the activity feed, so its own two fetches start now too
  // rather than after every other load has finished.
  const statsRead = loadOrNull<DashboardStats>(
    API.ADMIN.ORCHESTRATION.OBSERVABILITY_DASHBOARD_STATS
  );
  const [
    platform,
    costSummary,
    budgetAlerts,
    agentsCount,
    dashboardStats,
    models,
    setupState,
    activeQuarantines,
    activity,
  ] = await Promise.all([
    platformRead,
    loadOrNull<CostSummary>(API.ADMIN.ORCHESTRATION.COSTS_SUMMARY),
    loadOrNull<{ alerts: BudgetAlert[] }>(API.ADMIN.ORCHESTRATION.COSTS_ALERTS).then(
      (body) => body?.alerts ?? null
    ),
    // The org's own agents: every org also has its platform agents (§116), so
    // counting them would open a new org on "12 agents" (setup state excludes
    // them the same way).
    getPaginatedTotal(`${API.ADMIN.ORCHESTRATION.AGENTS}?isSystem=false`),
    statsRead,
    getModels(),
    platformRead.then((isPlatform) => (isPlatform ? getSetupState() : null)),
    platformRead.then((isPlatform) => (isPlatform ? getActiveQuarantines() : [])),
    // Activity feed merges conversations, executions, and errors.
    getActivityFeed(statsRead.then((stats) => stats?.recentErrors ?? null)),
  ]);

  const todayCostUsd = costSummary?.totals.today ?? null;
  const weekTrend = costSummary?.trend.slice(-7) ?? null;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">AI Orchestration</h1>
          <p className="text-muted-foreground text-sm">
            Operational overview — agents, spend, and activity.
          </p>
        </div>
        {setupState && <SetupWizardLauncher forceOpen={!setupState.hasProvider} />}
      </header>

      {setupState && <SetupRequiredBanner hasProvider={setupState.hasProvider} />}

      {budgetAlerts === null ? (
        <LoadFailedNotice what="budget alerts" />
      ) : (
        <BudgetAlertsBanner alerts={budgetAlerts} />
      )}

      {platform &&
        (activeQuarantines === null ? (
          <LoadFailedNotice what="capability quarantines" />
        ) : (
          <ActiveQuarantinesPanel rows={activeQuarantines} />
        ))}

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
          {weekTrend === null ? (
            <LoadFailedNotice what="the spend trend" />
          ) : (
            <CostTrendChart
              title="7-day spend trend"
              trend={weekTrend}
              perModel={null}
              models={models}
            />
          )}
          {dashboardStats === null ? (
            <LoadFailedNotice what="capability usage" />
          ) : (
            <TopCapabilitiesPanel capabilities={dashboardStats.topCapabilities} />
          )}
        </div>
        {activity === null ? (
          <LoadFailedNotice what="recent activity" />
        ) : (
          <DashboardActivityFeed items={activity} />
        )}
      </section>
    </div>
  );
}
