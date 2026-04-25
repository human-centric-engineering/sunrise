'use client';

/**
 * CapabilityStatsPanel — displays execution metrics for a single capability.
 *
 * Fetches stats from the capability stats endpoint and renders key
 * metrics (invocations, success rate, latency percentiles, cost) in
 * a card grid with a period selector.
 */

import { useCallback, useEffect, useState } from 'react';
import { Activity, Clock, DollarSign, TrendingUp, AlertCircle, Loader2 } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Period = '7d' | '30d' | '90d';

interface CapabilityStats {
  capabilityId: string;
  capabilitySlug: string;
  period: Period;
  invocations: number;
  successRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd: number;
  dailyBreakdown: {
    date: string;
    invocations: number;
    successRate: number;
    costUsd: number;
  }[];
}

interface CapabilityStatsPanelProps {
  capabilityId: string;
}

export function CapabilityStatsPanel({ capabilityId }: CapabilityStatsPanelProps) {
  const [stats, setStats] = useState<CapabilityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('30d');

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.get<CapabilityStats>(
        `${API.ADMIN.ORCHESTRATION.capabilityStats(capabilityId)}?period=${period}`
      );
      setStats(data);
    } catch {
      setError('Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, [capabilityId, period]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Execution Metrics</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Execution Metrics</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 py-8">
          <AlertCircle className="h-4 w-4 text-red-500" />
          <span className="text-muted-foreground text-sm">{error}</span>
        </CardContent>
      </Card>
    );
  }

  if (!stats) return null;

  const metrics = [
    {
      label: 'Invocations',
      value: stats.invocations.toLocaleString(),
      icon: Activity,
      color: 'text-blue-600 dark:text-blue-400',
    },
    {
      label: 'Success Rate',
      value: `${stats.successRate}%`,
      icon: TrendingUp,
      color:
        stats.successRate >= 95
          ? 'text-green-600 dark:text-green-400'
          : stats.successRate >= 80
            ? 'text-yellow-600 dark:text-yellow-400'
            : 'text-red-600 dark:text-red-400',
    },
    {
      label: 'Avg Latency',
      value: `${stats.avgLatencyMs}ms`,
      sub: `p50: ${stats.p50LatencyMs}ms · p95: ${stats.p95LatencyMs}ms`,
      icon: Clock,
      color: 'text-purple-600 dark:text-purple-400',
    },
    {
      label: 'Total Cost',
      value: `$${stats.totalCostUsd.toFixed(4)}`,
      icon: DollarSign,
      color: 'text-emerald-600 dark:text-emerald-400',
    },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Execution Metrics</CardTitle>
          <CardDescription>
            {stats.invocations === 0
              ? 'No invocations recorded yet. Metrics appear here when an AI agent uses this capability during a chat conversation.'
              : `${stats.invocations} invocations over the last ${period}`}
          </CardDescription>
        </div>
        <div className="flex gap-1">
          {(['7d', '30d', '90d'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                period === p
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {metrics.map((metric) => (
            <div key={metric.label} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <metric.icon className={cn('h-3.5 w-3.5', metric.color)} />
                <span className="text-muted-foreground text-xs">{metric.label}</span>
              </div>
              <div className="text-lg font-semibold">{metric.value}</div>
              {metric.sub && <div className="text-muted-foreground text-[11px]">{metric.sub}</div>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
