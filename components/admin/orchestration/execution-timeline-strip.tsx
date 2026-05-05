'use client';

/**
 * ExecutionTimelineStrip — a Gantt-style horizontal bar chart of step
 * durations across an execution.
 *
 * One bar per trace entry, widths proportional to the longest step
 * (so the slowest step always reads as 100% width). Hover reveals the
 * step label and `durationMs`; click bubbles the `stepId` so the parent
 * can scroll/expand the matching trace row.
 *
 * Status colour:
 *   - `failed`            → red
 *   - `awaiting_approval` → amber striped
 *   - slow outlier (≥ p90 in traces with ≥ 5 entries) → amber
 *   - everything else     → primary
 *
 * The strip hides itself for traces with fewer than 2 entries — a
 * single bar is not a useful comparison.
 */

import * as React from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { cn } from '@/lib/utils';
import { slowOutlierThresholdMs } from '@/lib/orchestration/trace/aggregate';
import type { ExecutionTraceEntry } from '@/types/orchestration';

export interface ExecutionTimelineStripProps {
  trace: ExecutionTraceEntry[];
  /** Fires with the clicked entry's `stepId`. Parent uses it to scroll/expand. */
  onSelectStep?: (stepId: string) => void;
  /** Highlight a specific bar (e.g., the row the user expanded below). */
  highlightedStepId?: string;
}

function barColour(
  entry: ExecutionTraceEntry,
  slowThresholdMs: number | null
): { className: string; striped: boolean } {
  if (entry.status === 'failed' || entry.status === 'rejected') {
    return { className: 'bg-red-500 dark:bg-red-600', striped: false };
  }
  if (entry.status === 'awaiting_approval') {
    return { className: 'bg-amber-400 dark:bg-amber-500', striped: true };
  }
  if (slowThresholdMs !== null && entry.durationMs >= slowThresholdMs) {
    return { className: 'bg-amber-500 dark:bg-amber-600', striped: false };
  }
  if (entry.status === 'skipped') {
    return { className: 'bg-muted-foreground/40', striped: false };
  }
  return { className: 'bg-primary', striped: false };
}

export function ExecutionTimelineStrip({
  trace,
  onSelectStep,
  highlightedStepId,
}: ExecutionTimelineStripProps): React.ReactElement | null {
  if (trace.length < 2) return null;

  const maxDuration = trace.reduce((m, e) => Math.max(m, e.durationMs), 0);
  const slowThreshold = slowOutlierThresholdMs(trace);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          Step timeline
          <FieldHelp title="Reading the timeline">
            <p>
              Each bar is one workflow step, with width proportional to the slowest step in the run
              (so the longest bar is always 100% wide).
            </p>
            <p className="text-foreground mt-2 font-medium">Colours</p>
            <p>
              <span className="text-red-600 dark:text-red-400">Red</span> — failed.{' '}
              <span className="text-amber-500">Amber</span> — slow outlier (≥ 90th percentile) or
              awaiting approval. <span className="text-primary">Primary</span> — completed.
              Translucent grey — skipped.
            </p>
            <p className="text-foreground mt-2 font-medium">Interaction</p>
            <p>Click any bar to jump to that step in the trace below.</p>
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="space-y-1"
          aria-label="Step duration timeline"
          data-testid="execution-timeline-strip"
        >
          {trace.map((entry, idx) => {
            const widthPct = maxDuration > 0 ? (entry.durationMs / maxDuration) * 100 : 0;
            const { className: colourClass, striped } = barColour(entry, slowThreshold);
            const isHighlighted = highlightedStepId === entry.stepId;
            return (
              <button
                type="button"
                key={`${entry.stepId}-${idx}`}
                aria-label={`${entry.label} — ${entry.durationMs} milliseconds`}
                data-testid={`timeline-bar-${entry.stepId}`}
                data-status={entry.status}
                data-slow={
                  slowThreshold !== null && entry.durationMs >= slowThreshold ? 'true' : 'false'
                }
                onClick={() => onSelectStep?.(entry.stepId)}
                className={cn(
                  'group flex w-full items-center gap-2 rounded text-left text-xs transition-colors',
                  'hover:bg-muted/50 focus-visible:outline-primary focus-visible:outline-2 focus-visible:outline-offset-2',
                  isHighlighted && 'bg-muted/60'
                )}
              >
                <span className="text-muted-foreground w-32 shrink-0 truncate font-mono">
                  {entry.label}
                </span>
                <span className="bg-muted/30 relative h-4 flex-1 overflow-hidden rounded">
                  <span
                    className={cn(
                      'absolute inset-y-0 left-0 transition-[width]',
                      colourClass,
                      striped &&
                        'bg-[image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(0,0,0,0.15)_4px,rgba(0,0,0,0.15)_8px)]'
                    )}
                    style={{ width: `${widthPct.toFixed(2)}%` }}
                  />
                </span>
                <span className="text-muted-foreground w-20 shrink-0 text-right tabular-nums">
                  {entry.durationMs.toLocaleString()} ms
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
