'use client';

/**
 * PricingReference — collapsible card showing per-model token rates.
 *
 * Surfaces the model registry pricing so admins understand what each
 * model costs and where that pricing comes from. Includes a "last
 * synced" timestamp and source indicator (live OpenRouter vs static
 * fallback).
 */

import * as React from 'react';
import { ChevronDown, ChevronUp, History, RefreshCw } from 'lucide-react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ModelPriceHistoryChart } from '@/components/admin/orchestration/costs/model-price-history-chart';
import {
  deserialisePricingHistory,
  getModelTimeline,
  type SerializedPricingHistory,
} from '@/lib/orchestration/llm/pricing-history';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

export interface PricingReferenceProps {
  models: ModelInfo[] | null;
  /** Epoch ms when the registry was last populated from OpenRouter. 0 = static fallback only. */
  fetchedAt: number | null;
  /** Historical pricing data from llm-prices.com. null/undefined = not loaded / failed. */
  pricingHistory?: SerializedPricingHistory | null;
}

function tierVariant(tier: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (tier === 'frontier') return 'default';
  if (tier === 'mid') return 'secondary';
  if (tier === 'local') return 'outline';
  return 'outline';
}

function formatRate(costPerMillion: number): string {
  if (costPerMillion === 0) return 'Free';
  if (costPerMillion < 1) return `$${costPerMillion.toFixed(3)}/M`;
  if (costPerMillion < 10) return `$${costPerMillion.toFixed(2)}/M`;
  return `$${costPerMillion.toFixed(0)}/M`;
}

function formatLastSynced(fetchedAt: number | null): string {
  if (!fetchedAt || fetchedAt === 0) return 'Never (using static fallback)';
  const ago = Date.now() - fetchedAt;
  const hours = Math.floor(ago / (1000 * 60 * 60));
  const minutes = Math.floor(ago / (1000 * 60));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function PricingReference({ models, fetchedAt, pricingHistory }: PricingReferenceProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [selectedModelId, setSelectedModelId] = React.useState<string | null>(null);

  const historyData = React.useMemo(
    () => (pricingHistory ? deserialisePricingHistory(pricingHistory) : null),
    [pricingHistory]
  );

  const selectedTimeline = React.useMemo(() => {
    if (!selectedModelId || !historyData) return null;
    const model = (models ?? []).find((m) => m.id === selectedModelId);
    return getModelTimeline(historyData, selectedModelId, model?.provider);
  }, [selectedModelId, historyData, models]);

  const sorted = React.useMemo(() => {
    if (!models || models.length === 0) return [];
    return [...models]
      .filter((m) => m.tier !== 'local' || m.id === 'local:generic')
      .sort((a, b) => {
        // Sort by tier priority then by input cost
        const tierOrder: Record<string, number> = { frontier: 0, mid: 1, budget: 2, local: 3 };
        const tierDiff = (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9);
        if (tierDiff !== 0) return tierDiff;
        return b.inputCostPerMillion - a.inputCostPerMillion;
      });
  }, [models]);

  const isLive = fetchedAt !== null && fetchedAt > 0;

  return (
    <Card data-testid="pricing-reference">
      <CardHeader className="cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base">Model pricing reference</CardTitle>
            <Badge variant={isLive ? 'secondary' : 'outline'} className="text-[11px]">
              {isLive ? 'Live pricing' : 'Static fallback'}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              <RefreshCw className="mr-1 inline h-3 w-3" />
              {formatLastSynced(fetchedAt)}
            </span>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent>
          <div className="text-muted-foreground mb-4 text-sm">
            <span>Per-token rates used to calculate your spend figures. Rates marked </span>
            <Badge variant="secondary" className="inline-flex text-[10px]">
              Live
            </Badge>
            <span>
              {' '}
              are fetched from OpenRouter every 24 hours and reflect current market prices.{' '}
            </span>
            <Badge variant="outline" className="inline-flex text-[10px]">
              Fallback
            </Badge>
            <span>
              {' '}
              rates are approximate static values used when the live feed is unavailable.
            </span>
            {!isLive && (
              <span className="mt-1 block text-xs">
                Showing static fallback rates. Live pricing will activate on next page load when
                OpenRouter is reachable. Reload this page to retry.
              </span>
            )}
          </div>

          {historyData && historyData.source === 'live' && (
            <div className="text-muted-foreground mb-3 text-xs">
              <History className="mr-1 inline h-3 w-3" />
              <span>Click a model row with a </span>
              <History className="inline h-3 w-3" />
              <span> icon to view its historical pricing chart.</span>
            </div>
          )}

          {sorted.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">No models in registry.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Input rate</TableHead>
                  <TableHead className="text-right">Output rate</TableHead>
                  <TableHead className="text-right">Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((m) => {
                  const isSelected = selectedModelId === m.id;
                  const hasHistory = historyData
                    ? getModelTimeline(historyData, m.id, m.provider) !== null
                    : false;

                  return (
                    <TableRow
                      key={m.id}
                      className={`hover:bg-muted/50 cursor-pointer ${isSelected ? 'bg-muted/70 border-l-primary border-l-2' : ''}`}
                      onClick={() => setSelectedModelId(isSelected ? null : m.id)}
                    >
                      <TableCell className="font-mono text-xs">
                        <div className="flex items-center gap-1.5">
                          <span>{m.name}</span>
                          {hasHistory && <History className="h-3 w-3 text-blue-500" />}
                        </div>
                        <div className="text-muted-foreground text-[10px]">{m.id}</div>
                      </TableCell>
                      <TableCell className="text-sm capitalize">{m.provider}</TableCell>
                      <TableCell>
                        <Badge variant={tierVariant(m.tier)} className="capitalize">
                          {m.tier}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatRate(m.inputCostPerMillion)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatRate(m.outputCostPerMillion)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={isLive ? 'secondary' : 'outline'} className="text-[10px]">
                          {isLive ? 'Live' : 'Fallback'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {/* Price history chart for selected model */}
          {selectedModelId && (
            <div className="mt-4 rounded-md border border-blue-200 bg-blue-50/30 p-4 dark:border-blue-900 dark:bg-blue-950/20">
              {selectedTimeline ? (
                <ModelPriceHistoryChart timeline={selectedTimeline} />
              ) : (
                <div className="py-4 text-center">
                  <p className="text-muted-foreground text-sm">
                    No historical pricing data available for this model.
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    History is sourced from{' '}
                    <a
                      href="https://www.llm-prices.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      llm-prices.com
                    </a>{' '}
                    and may not cover all models yet.
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="text-muted-foreground mt-4 space-y-1 border-t pt-3 text-xs">
            <p>
              <strong>Rates are per million tokens.</strong> A typical chat turn uses 500–2,000
              input tokens and 200–1,000 output tokens. A 10-turn conversation on a frontier model
              (~$15/M input, ~$75/M output) costs roughly $0.08–$0.90 depending on context length.
            </p>
            <p>
              Pricing updates automatically every 24h from OpenRouter. Use the{' '}
              <code className="bg-muted rounded px-1">?refresh=true</code> query on the models
              endpoint to force a manual refresh.
            </p>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
