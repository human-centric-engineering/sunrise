'use client';

/**
 * ExecutionAggregates — summary card row above the trace timeline.
 *
 * Surfaces the aggregates the trace viewer cares about that aren't
 * obvious from scrolling the per-step list: step-time sum, p50 / p95
 * step duration, slowest step, total LLM time and tokens, and a
 * per-step-type breakdown.
 *
 * "Step time sum" is the sum of per-step `durationMs` — NOT wall-clock.
 * Parallel branches contribute each branch's full duration, so the value
 * exceeds true wall-clock for workflows with `parallel` steps. The true
 * wall-clock duration is shown in the Duration card up in the summary
 * grid (`startedAt`/`completedAt`).
 *
 * Hidden when the trace has fewer than 2 entries — single-step traces
 * have no aggregate to summarise.
 */

import * as React from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { computeTraceAggregates } from '@/lib/orchestration/trace/aggregate';
import type { ExecutionTraceEntry } from '@/types/orchestration';

export interface ExecutionAggregatesProps {
  trace: ExecutionTraceEntry[];
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toLocaleString()} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function ExecutionAggregates({
  trace,
}: ExecutionAggregatesProps): React.ReactElement | null {
  if (trace.length < 2) return null;

  const aggregates = computeTraceAggregates(trace);
  // Fraction of step-time-sum spent inside LLM calls. Using the sum (not
  // wall-clock) keeps the share consistent with the per-entry `llmDurationMs`
  // values it's derived from.
  const llmFraction =
    aggregates.stepTimeSumMs > 0
      ? (aggregates.totalLlmDurationMs / aggregates.stepTimeSumMs) * 100
      : 0;
  const stepTypes = Object.entries(aggregates.byStepType).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <Card data-testid="execution-aggregates">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          Aggregates
          <FieldHelp title="Trace aggregates">
            <p>Quick summary across the whole run.</p>
            <p className="text-foreground mt-2 font-medium">Step time sum</p>
            <p>
              Sum of per-step durations. NOT wall-clock — parallel branches each contribute their
              full duration, so this exceeds the actual run time for workflows with parallel steps.
              The Duration card above shows the true wall-clock.
            </p>
            <p className="text-foreground mt-2 font-medium">p50 / p95 duration</p>
            <p>
              Median and 95th-percentile step duration — the bulk of work happens at the p50, while
              the p95 surfaces the slow tail.
            </p>
            <p className="text-foreground mt-2 font-medium">LLM share</p>
            <p>
              Fraction of step time sum spent inside LLM calls. The rest is engine overhead, tool
              I/O, or DB checkpointing.
            </p>
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground text-xs">Step time sum</dt>
            <dd className="text-base font-semibold tabular-nums">
              {formatMs(aggregates.stepTimeSumMs)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">p50 / p95</dt>
            <dd className="text-base font-semibold tabular-nums">
              {aggregates.p50DurationMs !== null && aggregates.p95DurationMs !== null
                ? `${formatMs(aggregates.p50DurationMs)} · ${formatMs(aggregates.p95DurationMs)}`
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Slowest step</dt>
            <dd
              className="truncate text-base font-semibold"
              title={aggregates.slowestStep?.label ?? ''}
            >
              {aggregates.slowestStep ? (
                <>
                  {aggregates.slowestStep.label}{' '}
                  <span className="text-muted-foreground text-xs font-normal tabular-nums">
                    ({formatMs(aggregates.slowestStep.durationMs)})
                  </span>
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">LLM share</dt>
            <dd className="text-base font-semibold tabular-nums">
              {aggregates.totalLlmDurationMs > 0
                ? `${formatMs(aggregates.totalLlmDurationMs)} (${llmFraction.toFixed(0)}%)`
                : '—'}
            </dd>
          </div>
        </dl>

        {stepTypes.length > 0 && (
          <div className="mt-4 border-t pt-3">
            <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
              By step type
            </p>
            <ul className="grid gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
              {stepTypes.map(([type, bucket]) => (
                <li
                  key={type}
                  data-testid={`aggregates-step-type-${type}`}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="text-foreground font-mono">{type}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {bucket.count} · {formatMs(bucket.durationMs)}
                    {bucket.tokens > 0 ? ` · ${bucket.tokens.toLocaleString()} tok` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(aggregates.totalInputTokens > 0 || aggregates.totalOutputTokens > 0) && (
          <p className="text-muted-foreground mt-3 text-xs tabular-nums">
            Tokens: {aggregates.totalInputTokens.toLocaleString()} in ·{' '}
            {aggregates.totalOutputTokens.toLocaleString()} out
          </p>
        )}
      </CardContent>
    </Card>
  );
}
