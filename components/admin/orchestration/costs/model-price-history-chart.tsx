'use client';

/**
 * ModelPriceHistoryChart — step chart showing historical pricing for a model.
 *
 * Renders a step line chart (price stays flat until the next change date)
 * showing input and output token rates over time. Data comes from
 * llm-prices.com via the `SerializedPricingHistory` prop.
 *
 * Displayed inline within the PricingReference table when a model row
 * is clicked.
 */

import * as React from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { ModelPricingTimeline } from '@/lib/orchestration/llm/pricing-history';

export interface ModelPriceHistoryChartProps {
  timeline: ModelPricingTimeline;
}

interface ChartPoint {
  date: string;
  input: number;
  output: number;
}

/**
 * Convert a pricing timeline (date ranges) into plottable points.
 * Each period becomes two points: one at fromDate and one at the day
 * before toDate (or today if current). This creates the step effect.
 */
function buildChartData(timeline: ModelPricingTimeline): ChartPoint[] {
  const points: ChartPoint[] = [];

  for (const period of timeline.periods) {
    // Start of this pricing period
    points.push({
      date: period.fromDate,
      input: period.input,
      output: period.output,
    });

    // End of this pricing period (day before next, or today if current)
    const endDate = period.toDate ?? new Date().toISOString().slice(0, 10);
    if (endDate !== period.fromDate) {
      points.push({
        date: endDate,
        input: period.input,
        output: period.output,
      });
    }
  }

  // Deduplicate by date (keep latest if two periods share a boundary)
  const byDate = new Map<string, ChartPoint>();
  for (const pt of points) {
    byDate.set(pt.date, pt);
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function formatRate(value: number): string {
  if (value === 0) return '$0';
  if (value < 1) return `$${value.toFixed(3)}`;
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(0)}`;
}

export function ModelPriceHistoryChart({ timeline }: ModelPriceHistoryChartProps) {
  const data = React.useMemo(() => buildChartData(timeline), [timeline]);

  if (data.length === 0) {
    return (
      <p className="text-muted-foreground py-4 text-center text-xs">
        No pricing history available for this model.
      </p>
    );
  }

  // Calculate price change summary
  const firstInput = data[0].input;
  const lastInput = data[data.length - 1].input;
  const inputChange =
    firstInput > 0 ? Math.round(((lastInput - firstInput) / firstInput) * 100) : 0;

  const firstOutput = data[0].output;
  const lastOutput = data[data.length - 1].output;
  const outputChange =
    firstOutput > 0 ? Math.round(((lastOutput - firstOutput) / firstOutput) * 100) : 0;

  return (
    <div data-testid="model-price-history-chart" className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {timeline.name} <span className="text-muted-foreground text-xs">({timeline.vendor})</span>
        </p>
        <div className="flex gap-3 text-xs">
          {inputChange !== 0 && (
            <span className={inputChange < 0 ? 'text-green-600' : 'text-red-600'}>
              Input: {inputChange > 0 ? '+' : ''}
              {inputChange}%
            </span>
          )}
          {outputChange !== 0 && (
            <span className={outputChange < 0 ? 'text-green-600' : 'text-red-600'}>
              Output: {outputChange > 0 ? '+' : ''}
              {outputChange}%
            </span>
          )}
          {inputChange === 0 && outputChange === 0 && (
            <span className="text-muted-foreground">No price changes</span>
          )}
        </div>
      </div>

      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => formatRate(v)}
              label={{
                value: '$/M tokens',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 10 },
              }}
            />
            <Tooltip
              formatter={(value, name) => [
                `${formatRate(typeof value === 'number' ? value : Number(value) || 0)}/M tokens`,
                String(name) === 'input' ? 'Input' : 'Output',
              ]}
              labelFormatter={(label) => `Date: ${String(label)}`}
              contentStyle={{ fontSize: 11 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              type="stepAfter"
              dataKey="input"
              stroke="#60a5fa"
              strokeWidth={2}
              dot={true}
              name="Input"
            />
            <Line
              type="stepAfter"
              dataKey="output"
              stroke="#f472b6"
              strokeWidth={2}
              dot={true}
              name="Output"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="text-muted-foreground flex justify-between text-[10px]">
        <span>
          Data from{' '}
          <a
            href="https://www.llm-prices.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            llm-prices.com
          </a>
        </span>
        <span>
          {data[0].date} — {data[data.length - 1].date} ({timeline.periods.length} price{' '}
          {timeline.periods.length === 1 ? 'point' : 'changes'})
        </span>
      </div>
    </div>
  );
}
