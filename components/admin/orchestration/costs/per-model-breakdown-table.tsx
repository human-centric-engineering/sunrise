'use client';

/**
 * PerModelBreakdownTable — month-to-date spend by model, joined with
 * the in-memory model registry to annotate provider, tier, and local
 * badge.
 *
 * Local rows always render `$0.00` regardless of what `byModel`
 * reports, because cost-tracker logs `totalCostUsd: 0` for local
 * providers anyway — the explicit rendering is just defensive.
 *
 * Spend is the platform's, as the cards above show it. Spend on orgs' own
 * keys, which the vendor bills to the org (§137 t-1058), has a column of its
 * own when there is any.
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
import { Tip } from '@/components/ui/tooltip';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Usd } from '@/components/admin/orchestration/costs/usd';
import { platformSpend } from '@/components/admin/orchestration/costs/platform-spend';
import { buildModelIndex, lookupModel } from '@/components/admin/orchestration/costs/model-index';
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
  const modelIndex = React.useMemo(() => buildModelIndex(models), [models]);

  const enriched = React.useMemo(() => {
    const list = rows ?? [];
    return list
      .map((row) => {
        // Provider-keyed: two catalogue entries can share a model id, and the
        // cost log knows which provider actually served the spend (#436).
        const info = lookupModel(modelIndex, row.provider, row.model);
        const isLocal = info?.tier === 'local';
        return {
          ...row,
          info,
          isLocal,
          displaySpend: isLocal ? 0 : platformSpend(row.monthSpend, row.ownKeyMonthSpend),
          ownKeySpend: isLocal ? 0 : row.ownKeyMonthSpend,
        };
      })
      .sort((a, b) => b.displaySpend - a.displaySpend || b.ownKeySpend - a.ownKeySpend);
  }, [rows, modelIndex]);
  const showOwnKeys = enriched.some((row) => row.ownKeySpend > 0);

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
                <TableHead>
                  <Tip label="The specific LLM model identifier (e.g. claude-opus-4-6)">
                    <span>Model</span>
                  </Tip>
                </TableHead>
                <TableHead>
                  <Tip label="The LLM provider this model belongs to">
                    <span>Provider</span>
                  </Tip>
                </TableHead>
                <TableHead>
                  <Tip label="Model pricing tier — frontier (most capable/expensive), standard, or budget">
                    <span>Tier</span>
                  </Tip>
                </TableHead>
                <TableHead className="text-right">
                  <Tip label="Month-to-date LLM cost for this model across all agents, on the platform's keys">
                    <span>Spend</span>
                  </Tip>
                </TableHead>
                {showOwnKeys && (
                  <TableHead className="text-right">
                    <Tip label="Month-to-date LLM cost for this model on organisations' own AI keys, billed to them by the provider">
                      <span>Own keys</span>
                    </Tip>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {enriched.map((row) => (
                // Keyed by provider too — the same model id can appear twice,
                // once per provider that served it.
                <TableRow key={`${row.provider}::${row.model}`}>
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
                  {/* From the cost log, not the catalogue — this is the
                      provider that actually served and billed the spend. */}
                  <TableCell className="text-sm">{row.provider || '—'}</TableCell>
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
                  {showOwnKeys && (
                    <TableCell className="text-right">
                      <Usd value={row.ownKeySpend} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
