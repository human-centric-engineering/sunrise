'use client';

/**
 * PerAgentCostTable — month-to-date spend per agent with budget
 * utilisation bar.
 *
 * Sort by monthSpend descending by default. Click the "Spend" or
 * "Utilisation" headers to flip the sort. Rows link to the agent
 * detail page so admins can jump straight into a budget edit.
 *
 * Utilisation colours (cross-referenced with `budget-alerts-banner`):
 *   ≤ 50%  → green
 *   ≤ 80%  → amber
 *   > 80%  → red
 */

import * as React from 'react';
import Link from 'next/link';

import { Tip } from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Usd } from '@/components/admin/orchestration/costs/usd';
import { cn } from '@/lib/utils';
import type { CostSummaryAgentRow } from '@/lib/orchestration/llm/cost-reports';

export interface PerAgentCostTableProps {
  rows: CostSummaryAgentRow[] | null;
}

type SortKey = 'spend' | 'utilisation';

function utilisationColour(utilisation: number | null): string {
  if (utilisation === null) return 'bg-muted';
  if (utilisation > 0.8) return 'bg-red-500 dark:bg-red-600';
  if (utilisation > 0.5) return 'bg-amber-500 dark:bg-amber-600';
  return 'bg-emerald-500 dark:bg-emerald-600';
}

function UtilisationBar({ utilisation }: { utilisation: number | null }) {
  if (utilisation === null) {
    return <span className="text-muted-foreground text-xs">No budget set</span>;
  }
  const pct = Math.min(100, Math.max(0, utilisation * 100));
  return (
    <div className="flex items-center gap-2">
      <div
        className="bg-muted relative h-2 w-24 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label="Budget utilisation"
      >
        <div
          className={cn('h-full transition-all', utilisationColour(utilisation))}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-muted-foreground text-xs tabular-nums">
        {Math.round(utilisation * 100)}%
      </span>
    </div>
  );
}

export function PerAgentCostTable({ rows }: PerAgentCostTableProps) {
  const [sortKey, setSortKey] = React.useState<SortKey>('spend');

  const sorted = React.useMemo(() => {
    const list = rows ?? [];
    const copy = [...list];
    if (sortKey === 'spend') {
      copy.sort((a, b) => b.monthSpend - a.monthSpend);
    } else {
      copy.sort((a, b) => (b.utilisation ?? -1) - (a.utilisation ?? -1));
    }
    return copy;
  }, [rows, sortKey]);

  return (
    <Card data-testid="per-agent-cost-table">
      <CardHeader>
        <CardTitle className="text-base">Spend by agent (this month)</CardTitle>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No agent spend recorded this month.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Tip label="The agent incurring LLM costs">
                    <span>Agent</span>
                  </Tip>
                </TableHead>
                <TableHead className="text-right">
                  <Tip label="Sort by month-to-date LLM spend">
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => setSortKey('spend')}
                    >
                      Spend{sortKey === 'spend' ? ' ↓' : ''}
                    </button>
                  </Tip>
                </TableHead>
                <TableHead className="text-right">
                  <Tip label="Monthly budget cap in USD — blank means no limit">
                    <span>Budget</span>
                  </Tip>
                </TableHead>
                <TableHead>
                  <Tip label="Percentage of monthly budget spent — green ≤ 50%, amber 50–80%, red > 80%">
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => setSortKey('utilisation')}
                    >
                      Utilisation{sortKey === 'utilisation' ? ' ↓' : ''}
                    </button>
                  </Tip>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow key={row.agentId}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/orchestration/agents/${row.agentId}`}
                      className="hover:underline"
                    >
                      {row.name}
                    </Link>
                    <div className="text-muted-foreground font-mono text-xs">{row.slug}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Usd value={row.monthSpend} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Usd value={row.monthlyBudgetUsd} />
                  </TableCell>
                  <TableCell>
                    <UtilisationBar utilisation={row.utilisation} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
