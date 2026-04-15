import type { Metadata } from 'next';

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
import { FieldHelp } from '@/components/ui/field-help';
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  getCostSummary,
  getBudgetAlerts,
  type CostSummary,
} from '@/lib/orchestration/llm/cost-reports';
import { getAvailableModels } from '@/lib/orchestration/llm/model-registry';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

export const metadata: Metadata = {
  title: 'AI Orchestration',
  description: 'Overview of agents, workflows, costs, and recent activity.',
};

interface DashboardStats {
  activeConversations: number;
  todayRequests: number;
  errorRate: number;
  recentErrors: RecentError[];
  topCapabilities: CapabilityUsage[];
}

async function getRecentActivity(userId: string): Promise<RecentActivityItem[]> {
  const [conversations, executions] = await Promise.all([
    prisma.aiConversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    }),
    prisma.aiWorkflowExecution.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

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

  items.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  return items;
}

async function getDashboardStats(userId: string): Promise<DashboardStats | null> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    activeConversations,
    todayRequests,
    totalExecutions24h,
    failedExecutions24h,
    recentErrors,
    topCapabilities,
  ] = await Promise.all([
    prisma.aiConversation.count({
      where: { userId, isActive: true },
    }),
    prisma.aiCostLog.count({
      where: { createdAt: { gte: todayStart } },
    }),
    prisma.aiWorkflowExecution.count({
      where: { userId, createdAt: { gte: twentyFourHoursAgo } },
    }),
    prisma.aiWorkflowExecution.count({
      where: { userId, status: 'failed', createdAt: { gte: twentyFourHoursAgo } },
    }),
    prisma.aiWorkflowExecution.findMany({
      where: { userId, status: 'failed' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, errorMessage: true, workflowId: true, createdAt: true },
    }),
    prisma.aiMessage.groupBy({
      by: ['capabilitySlug'],
      where: {
        capabilitySlug: { not: null },
        conversation: { userId },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
  ]);

  const errorRate = totalExecutions24h === 0 ? 0 : failedExecutions24h / totalExecutions24h;

  return {
    activeConversations,
    todayRequests,
    errorRate,
    recentErrors: recentErrors.map((e) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
    })),
    topCapabilities: topCapabilities.map((row) => ({
      slug: row.capabilitySlug as string,
      count: row._count.id,
    })),
  };
}

export default async function OrchestrationDashboardPage() {
  const session = await getServerSession();
  const userId = session?.user?.id;

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
    getCostSummary().catch((err) => {
      logger.error('orchestration dashboard: failed to load cost summary', err);
      return null as CostSummary | null;
    }),
    getBudgetAlerts().catch((err) => {
      logger.error('orchestration dashboard: failed to load budget alerts', err);
      return null;
    }),
    prisma.aiAgent.count().catch(() => null),
    prisma.aiWorkflow.count().catch(() => null),
    userId
      ? prisma.aiConversation.count({ where: { userId } }).catch(() => null)
      : Promise.resolve(null),
    userId
      ? getRecentActivity(userId).catch((err) => {
          logger.error('orchestration dashboard: failed to load recent activity', err);
          return null;
        })
      : Promise.resolve(null),
    userId
      ? getDashboardStats(userId).catch((err) => {
          logger.error('orchestration dashboard: failed to load observability stats', err);
          return null;
        })
      : Promise.resolve(null),
    Promise.resolve(getAvailableModels()).catch(() => null as ModelInfo[] | null),
  ]);

  const todayCostUsd = costSummary?.totals.today ?? null;

  // Slice the 30-day trend to last 7 days for the dashboard chart.
  const weekTrend = costSummary?.trend.slice(-7) ?? null;

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            AI Orchestration{' '}
            <FieldHelp
              title="What is AI orchestration?"
              contentClassName="w-96 max-h-80 overflow-y-auto"
            >
              <p>
                AI Orchestration is the control plane for building and running agentic AI systems.
                It lets you configure agents (AI personas), wire them to LLM providers, give them
                capabilities (tools), chain them into workflows, and monitor cost and performance.
              </p>
              <p className="text-foreground mt-2 font-medium">Key concepts</p>
              <p>
                <strong>Agents</strong> reason and respond. <strong>Capabilities</strong> let agents
                take actions. <strong>Providers</strong> supply the LLM backends.{' '}
                <strong>Workflows</strong> chain steps into pipelines. The{' '}
                <strong>knowledge base</strong> gives agents access to your documents via semantic
                search.
              </p>
              <p className="text-foreground mt-2 font-medium">This page</p>
              <p>
                A summary dashboard showing agent count, workflow count, today&apos;s spend, recent
                activity, and system health. Use the sidebar to navigate to each section.
              </p>
            </FieldHelp>
          </h1>
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
