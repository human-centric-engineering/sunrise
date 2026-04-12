'use client';

/**
 * BudgetAlertsList — richer alert list than the dashboard's
 * `<BudgetAlertsBanner>`.
 *
 * For every agent at or above 80% of its monthly budget, render two
 * actions:
 *
 *   1. "Adjust budget" — deep-link to the agent edit page.
 *   2. "Pause agent"   — PATCH `/agents/:id` with `isActive: false`
 *      optimistically. On failure the row reverts and an inline
 *      error banner surfaces the reason.
 *
 * This component is interactive so it lives as a client island; the
 * banner on the dashboard stays a pure server component.
 */

import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, AlertTriangle, Loader2, Pause } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Usd } from '@/components/admin/orchestration/costs/usd';
import { cn } from '@/lib/utils';
import type { BudgetAlert } from '@/lib/orchestration/llm/cost-reports';

export interface BudgetAlertsListProps {
  alerts: BudgetAlert[] | null;
}

interface RowState {
  pausing: boolean;
  paused: boolean;
  error: string | null;
}

export function BudgetAlertsList({ alerts }: BudgetAlertsListProps) {
  const [state, setState] = React.useState<Record<string, RowState>>({});

  if (!alerts || alerts.length === 0) {
    return (
      <Card data-testid="budget-alerts-list">
        <CardHeader>
          <CardTitle className="text-base">Budget alerts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No agents are currently over 80% of their monthly budget.
          </p>
        </CardContent>
      </Card>
    );
  }

  const handlePause = async (agentId: string) => {
    setState((prev) => ({
      ...prev,
      [agentId]: { pausing: true, paused: !!prev[agentId]?.paused, error: null },
    }));
    // Optimistic: mark paused immediately.
    setState((prev) => ({
      ...prev,
      [agentId]: { pausing: true, paused: true, error: null },
    }));
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.agentById(agentId), {
        body: { isActive: false },
      });
      setState((prev) => ({
        ...prev,
        [agentId]: { pausing: false, paused: true, error: null },
      }));
    } catch (err) {
      const message =
        err instanceof APIClientError ? err.message : 'Could not pause agent. Try again.';
      // Revert.
      setState((prev) => ({
        ...prev,
        [agentId]: { pausing: false, paused: false, error: message },
      }));
    }
  };

  return (
    <Card data-testid="budget-alerts-list">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle
            className="h-4 w-4 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          Budget alerts ({alerts.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {alerts.map((alert) => {
            const rowState = state[alert.agentId] ?? {
              pausing: false,
              paused: false,
              error: null,
            };
            return (
              <li key={alert.agentId} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/admin/orchestration/agents/${alert.agentId}`}
                        className="font-medium hover:underline"
                      >
                        {alert.name}
                      </Link>
                      <Badge
                        variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}
                        className={cn(
                          alert.severity === 'warning' &&
                            'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
                        )}
                      >
                        {Math.round(alert.utilisation * 100)}%
                      </Badge>
                      {rowState.paused && (
                        <Badge variant="outline" className="text-[10px]">
                          Paused
                        </Badge>
                      )}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-xs">
                      <Usd value={alert.spent} /> / <Usd value={alert.monthlyBudgetUsd} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/admin/orchestration/agents/${alert.agentId}`}>
                        Adjust budget
                      </Link>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={rowState.pausing || rowState.paused}
                      onClick={() => void handlePause(alert.agentId)}
                    >
                      {rowState.pausing ? (
                        <>
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          Pausing…
                        </>
                      ) : (
                        <>
                          <Pause className="mr-1 h-3 w-3" />
                          {rowState.paused ? 'Paused' : 'Pause agent'}
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                {rowState.error && (
                  <div className="mt-2 flex items-center gap-2 rounded-md bg-red-50 p-2 text-xs text-red-600 dark:bg-red-950/20 dark:text-red-400">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    {rowState.error}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
