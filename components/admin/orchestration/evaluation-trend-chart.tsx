'use client';

/**
 * Per-agent evaluation-quality trend chart.
 *
 * Three lines (faithfulness, groundedness, relevance) over time, one
 * point per completed evaluation session for the agent. Sourced from
 * `GET /admin/orchestration/agents/:id/evaluation-trend`.
 *
 * Hidden when there are fewer than 2 points — a single point isn't a
 * trend, and the empty-state copy below covers the zero-points case.
 *
 * Mirrors the import set + structure of `cost-trend-chart.tsx`. No new
 * chart dependency.
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

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface EvaluationTrendPoint {
  sessionId: string;
  title: string;
  completedAt: string;
  avgFaithfulness: number | null;
  avgGroundedness: number | null;
  avgRelevance: number | null;
  scoredLogCount: number;
}

export interface EvaluationTrendChartProps {
  points: EvaluationTrendPoint[];
  /** Override the card title. Defaults to "Evaluation quality over time". */
  title?: string;
}

const COLOURS = {
  faithfulness: '#10b981', // emerald-500
  groundedness: '#3b82f6', // blue-500
  relevance: '#a855f7', // purple-500
};

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function EvaluationTrendChart({
  points,
  title = 'Evaluation quality over time',
}: EvaluationTrendChartProps): React.ReactElement | null {
  const data = React.useMemo(
    () =>
      points.map((p) => ({
        date: formatDateShort(p.completedAt),
        title: p.title,
        faithfulness: p.avgFaithfulness,
        groundedness: p.avgGroundedness,
        relevance: p.avgRelevance,
      })),
    [points]
  );

  if (points.length < 2) {
    return null;
  }

  return (
    <Card data-testid="evaluation-trend-chart">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-muted-foreground text-xs">
          Averages across each completed evaluation session. Per-message scores are noisy below ~20
          messages — interpret trends, not individual values.
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full" role="img" aria-label={title}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 11 }}
                domain={[0, 1]}
                tickFormatter={(v: number) => v.toFixed(1)}
              />
              <Tooltip
                formatter={(value, name) => [
                  typeof value === 'number' ? value.toFixed(2) : 'n/a',
                  String(name ?? ''),
                ]}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="faithfulness"
                stroke={COLOURS.faithfulness}
                strokeWidth={2}
                connectNulls
                name="Faithfulness"
              />
              <Line
                type="monotone"
                dataKey="groundedness"
                stroke={COLOURS.groundedness}
                strokeWidth={2}
                connectNulls
                name="Groundedness"
              />
              <Line
                type="monotone"
                dataKey="relevance"
                stroke={COLOURS.relevance}
                strokeWidth={2}
                connectNulls
                name="Relevance"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
