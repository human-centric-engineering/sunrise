/**
 * Dashboard stats cards — consolidated operational metrics.
 *
 * Server component. Renders four clickable summary cards for the
 * orchestration dashboard: Agents, Today's Spend, Today's Requests,
 * Error Rate. Each card links to its detail page. Values may be `null`
 * — the cards render an em-dash in that case.
 *
 * Replaces the former OrchestrationStatsCards (4 cards) and
 * ObservabilityStatsCards (3 cards) with a single focused row of 4
 * operational metrics.
 */

import Link from 'next/link';
import { AlertTriangle, Bot, DollarSign, Zap } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface DashboardStatsCardsProps {
  agentsCount: number | null;
  todayCostUsd: number | null;
  todayRequests: number | null;
  errorRate: number | null;
}

interface StatCardData {
  title: string;
  value: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  alert?: boolean;
}

function StatCard({ title, value, description, icon, href, alert }: StatCardData) {
  return (
    <Link href={href} className="group block">
      <Card className="group-hover:border-primary/40 transition-colors">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <div className="text-muted-foreground" aria-hidden="true">
            {icon}
          </div>
        </CardHeader>
        <CardContent>
          <div className={cn('text-2xl font-bold', alert && 'text-red-600 dark:text-red-400')}>
            {value}
          </div>
          <p className="text-muted-foreground text-xs">{description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

function formatUsd(value: number | null): string {
  if (value === null) return '—';
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function DashboardStatsCards({
  agentsCount,
  todayCostUsd,
  todayRequests,
  errorRate,
}: DashboardStatsCardsProps) {
  const errorRateHigh = errorRate !== null && errorRate > 0.05;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Agents"
        value={formatCount(agentsCount)}
        description="Configured AI agents"
        icon={<Bot className="h-4 w-4" />}
        href="/admin/orchestration/agents"
      />
      <StatCard
        title="Today's spend"
        value={formatUsd(todayCostUsd)}
        description="LLM cost so far today (UTC)"
        icon={<DollarSign className="h-4 w-4" />}
        href="/admin/orchestration/costs"
      />
      <StatCard
        title="Today's requests"
        value={formatCount(todayRequests)}
        description="LLM calls since midnight UTC"
        icon={<Zap className="h-4 w-4" />}
        href="/admin/orchestration/conversations"
      />
      <StatCard
        title="Error rate (24h)"
        value={formatPercent(errorRate)}
        description="Failed / total executions"
        icon={
          <AlertTriangle className={cn('h-4 w-4', errorRateHigh ? 'text-red-500' : undefined)} />
        }
        href="/admin/orchestration/analytics"
        alert={errorRateHigh}
      />
    </div>
  );
}
