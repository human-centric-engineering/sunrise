'use client';

/**
 * PerModelBreakdownTable — month-to-date spend by model, joined with
 * the in-memory model registry to annotate provider, tier, and local
 * badge.
 *
 * Local rows always render `$0.00` regardless of what `byModel`
 * reports, because cost-tracker logs `totalCostUsd: 0` for local
 * providers anyway — the explicit rendering is just defensive.
 */

import * as React from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Usd } from '@/components/admin/orchestration/costs/usd';
import type { CostSummaryModelRow } from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

export interface PerModelBreakdownTableProps {
  rows: CostSummaryModelRow[] | null;
  models: ModelInfo[] | null;
}

function tierVariant(tier?: string): 'default' | 'secondary' | 'outline' {
  if (tier === 'frontier') return 'default';
  if (tier === 'mid') return 'secondary';
  return 'outline';
}

export function PerModelBreakdownTable({ rows, models }: PerModelBreakdownTableProps) {
  const modelById = React.useMemo(() => {
    const map = new Map<string, ModelInfo>();
    for (const m of models ?? []) map.set(m.id, m);
    return map;
  }, [models]);

  const enriched = React.useMemo(() => {
    const list = rows ?? [];
    return list
      .map((row) => {
        const info = modelById.get(row.model);
        const isLocal = info?.tier === 'local';
        return {
          ...row,
          info,
          isLocal,
          displaySpend: isLocal ? 0 : row.monthSpend,
        };
      })
      .sort((a, b) => b.displaySpend - a.displaySpend);
  }, [rows, modelById]);

  return (
    <Card data-testid="per-model-breakdown-table">
      <CardHeader>
        <CardTitle className="text-base">Spend by model (this month)</CardTitle>
      </CardHeader>
      <CardContent>
        {enriched.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No model spend recorded this month.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {enriched.map((row) => (
                <TableRow key={row.model}>
                  <TableCell className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span>{row.info?.name ?? row.model}</span>
                      {row.isLocal && (
                        <Badge variant="outline" className="text-[10px]">
                          Local
                        </Badge>
                      )}
                    </div>
                    {row.info?.name && (
                      <div className="text-muted-foreground text-[10px]">{row.model}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{row.info?.provider ?? '—'}</TableCell>
                  <TableCell>
                    {row.info?.tier ? (
                      <Badge variant={tierVariant(row.info.tier)} className="capitalize">
                        {row.info.tier}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Usd value={row.displaySpend} />
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
