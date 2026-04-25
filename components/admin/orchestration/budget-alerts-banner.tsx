/**
 * Budget alerts banner (Phase 4 Session 4.1)
 *
 * Server component. Renders nothing when the alerts list is empty or
 * null. Otherwise displays a strip of agents currently at or above 80%
 * of their monthly budget, linking each row to the agent detail page
 * (wired up in Session 4.2 — currently 404s gracefully).
 */

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatUsd } from '@/lib/utils/format-currency';
import type { BudgetAlert } from '@/lib/orchestration/llm/cost-reports';

export interface BudgetAlertsBannerProps {
  alerts: BudgetAlert[] | null;
}

function formatPercent(utilisation: number): string {
  return `${Math.round(utilisation * 100)}%`;
}

export function BudgetAlertsBanner({ alerts }: BudgetAlertsBannerProps) {
  if (!alerts || alerts.length === 0) return null;

  return (
    <Card data-testid="budget-alerts-banner">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle
            className="h-4 w-4 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          Budget alerts
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {alerts.map((alert) => (
            <li key={alert.agentId} className="flex items-center justify-between py-2">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/admin/orchestration/agents/${alert.agentId}`}
                  className="font-medium hover:underline"
                >
                  {alert.name}
                </Link>
                <div className="text-muted-foreground text-xs">
                  {formatUsd(alert.spent)} / {formatUsd(alert.monthlyBudgetUsd)}
                </div>
              </div>
              <Badge
                variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}
                className={cn(
                  'ml-4',
                  alert.severity === 'warning' &&
                    'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
                )}
              >
                {formatPercent(alert.utilisation)}
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
