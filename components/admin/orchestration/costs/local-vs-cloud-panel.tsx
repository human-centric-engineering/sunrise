'use client';

/**
 * LocalVsCloudPanel — shows how much of the month's spend went to
 * local models versus cloud models, plus a callout for the
 * hypothetical savings reported by `calculateLocalSavings()`.
 *
 * Request split is derived from `byModel` + the `/models` registry
 * (the tier `'local'` flags local models). Savings are pulled from
 * `summary.localSavings` — `null` means the helper errored and we
 * render a muted placeholder rather than throwing.
 */

import * as React from 'react';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Usd } from '@/components/admin/orchestration/costs/usd';
import type { CostSummary } from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

export interface LocalVsCloudPanelProps {
  summary: CostSummary | null;
  models: ModelInfo[] | null;
}

const COLOURS = {
  local: '#a78bfa', // violet-400
  cloud: '#60a5fa', // blue-400
};

function methodologyLabel(method: 'equivalent_hosted' | 'tier_fallback' | 'mixed'): string {
  if (method === 'equivalent_hosted') return 'Exact hosted-model match';
  if (method === 'tier_fallback') return 'Cheapest non-local in same tier';
  return 'Mixed (both methods)';
}

export function LocalVsCloudPanel({ summary, models }: LocalVsCloudPanelProps) {
  const tierByModel = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models ?? []) map.set(m.id, m.tier);
    return map;
  }, [models]);

  const { localSpend, cloudSpend } = React.useMemo(() => {
    const rows = summary?.byModel ?? [];
    let local = 0;
    let cloud = 0;
    for (const row of rows) {
      const tier = tierByModel.get(row.model);
      if (tier === 'local') {
        // Savings value tracked elsewhere; actual local spend is $0.
        local += 0;
      } else {
        cloud += row.monthSpend;
      }
    }
    return { localSpend: local, cloudSpend: cloud };
  }, [summary, tierByModel]);

  // We can't infer request counts from byModel (it's only spend), so we
  // instead use presence of any local/cloud rows as a boolean indicator
  // and size the wedges by either the spend or the savings as a proxy.
  const savings = summary?.localSavings;
  const pieData = [
    { name: 'Local (saved)', value: savings?.usd ?? 0, key: 'local' as const },
    { name: 'Cloud (spent)', value: cloudSpend, key: 'cloud' as const },
  ].filter((d) => d.value > 0);

  return (
    <Card data-testid="local-vs-cloud-panel">
      <CardHeader>
        <CardTitle className="text-base">Local vs. cloud</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {pieData.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No local-model activity this month.
          </p>
        ) : (
          <div className="h-48 w-full" role="img" aria-label="Local vs cloud spend split">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  outerRadius={70}
                  innerRadius={40}
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.key} fill={COLOURS[entry.key]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v) => {
                    const n = typeof v === 'number' ? v : Number(v) || 0;
                    return [`$${n.toFixed(2)}`, ''];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="bg-muted/40 flex items-center justify-between rounded-md border p-3">
          <div>
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
              Estimated savings
              <FieldHelp title="How savings are estimated">
                <p>
                  For every local-model row in the cost log this month, we look up what it would
                  have cost on an equivalent hosted model and sum the delta.
                </p>
                <ul className="list-disc pl-4">
                  <li>
                    <b>Exact hosted-model match</b> — the local id also exists as a hosted model
                    (e.g. <code>llama-3.3-70b</code>).
                  </li>
                  <li>
                    <b>Cheapest non-local in tier</b> — no exact match, so we substitute the
                    cheapest hosted model in the same tier.
                  </li>
                  <li>
                    <b>Mixed</b> — both paths contributed.
                  </li>
                </ul>
                <p>
                  Local-model rows always log <code>$0.00</code>; this is hypothetical.
                </p>
              </FieldHelp>
            </div>
            <Usd value={savings?.usd ?? null} className="text-xl font-semibold" />
          </div>
          <div className="text-right">
            <div className="text-muted-foreground text-xs">Methodology</div>
            <div className="text-sm">{savings ? methodologyLabel(savings.methodology) : '—'}</div>
            {savings && (
              <div className="text-muted-foreground text-xs">
                {savings.sampleSize} sample{savings.sampleSize === 1 ? '' : 's'}
              </div>
            )}
          </div>
        </div>

        <div className="text-muted-foreground flex justify-between text-xs">
          <span>
            Local spend: <Usd value={localSpend} />
          </span>
          <span>
            Cloud spend: <Usd value={cloudSpend} />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
