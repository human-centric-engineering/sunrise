/**
 * Observability stats cards (Phase 7 Session 7.2)
 *
 * Server component. Renders three summary cards for the observability
 * section of the dashboard: Active Conversations, Today's Requests,
 * Error Rate. Values may be `null` — the cards render an em-dash in
 * that case.
 */

import { Activity, AlertTriangle, Zap } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface ObservabilityStatsCardsProps {
  activeConversations: number | null;
  todayRequests: number | null;
  errorRate: number | null;
}

function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function ObservabilityStatsCards({
  activeConversations,
  todayRequests,
  errorRate,
}: ObservabilityStatsCardsProps) {
  const errorRateHigh = errorRate !== null && errorRate > 0.05;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Active Conversations</CardTitle>
          <Activity className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatCount(activeConversations)}</div>
          <p className="text-muted-foreground text-xs">Currently open sessions</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Today&apos;s Requests</CardTitle>
          <Zap className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatCount(todayRequests)}</div>
          <p className="text-muted-foreground text-xs">LLM calls since midnight UTC</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Error Rate (24h)</CardTitle>
          <AlertTriangle
            className={cn('h-4 w-4', errorRateHigh ? 'text-red-500' : 'text-muted-foreground')}
            aria-hidden="true"
          />
        </CardHeader>
        <CardContent>
          <div
            className={cn('text-2xl font-bold', errorRateHigh && 'text-red-600 dark:text-red-400')}
          >
            {formatPercent(errorRate)}
          </div>
          <p className="text-muted-foreground text-xs">Failed / total executions</p>
        </CardContent>
      </Card>
    </div>
  );
}
