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
import { CheckCircle2, Clock, GitBranch, Loader2, MinusCircle, XCircle } from 'lucide-react';

type DurationUnit = 'ms' | 's';

function formatDuration(ms: number, unit: DurationUnit): string {
  if (unit === 's') {
    // Two decimals keeps sub-second steps readable (e.g. 0.04 s) without
    // losing precision for short steps that would otherwise round to 0.
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return `${ms.toLocaleString()} ms`;
}

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { cn } from '@/lib/utils';
import {
  buildParallelBranchMap,
  slowOutlierThresholdMs,
} from '@/lib/orchestration/trace/aggregate';
import type { ExecutionTraceEntry } from '@/types/orchestration';

// The 'running' status is view-only — synthesised by the live-poll path for
// the in-flight step. Persisted entries never carry it. Keyed by string so
// the index lookup tolerates both the persisted union and the synthesised
// extension without needing a wider TS union on the trace entry itself.
const STATUS_ICON: Record<string, { Icon: React.ElementType; className: string; label: string }> = {
  completed: { Icon: CheckCircle2, className: 'text-green-500', label: 'Completed' },
  failed: { Icon: XCircle, className: 'text-red-500', label: 'Failed' },
  rejected: { Icon: XCircle, className: 'text-red-500', label: 'Rejected' },
  skipped: { Icon: MinusCircle, className: 'text-muted-foreground', label: 'Skipped' },
  awaiting_approval: { Icon: Clock, className: 'text-amber-500', label: 'Awaiting approval' },
  running: { Icon: Loader2, className: 'text-primary animate-spin', label: 'Running' },
};

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
): { className: string; striped: boolean; pulsing: boolean } {
  // The synthesised running entry (status: 'running') isn't part of the
  // persisted union — string-compare so this branch hits regardless.
  if ((entry.status as string) === 'running') {
    return { className: 'bg-primary/70', striped: false, pulsing: true };
  }
  if (entry.status === 'failed' || entry.status === 'rejected') {
    return { className: 'bg-red-500 dark:bg-red-600', striped: false, pulsing: false };
  }
  if (entry.status === 'awaiting_approval') {
    return { className: 'bg-amber-400 dark:bg-amber-500', striped: true, pulsing: false };
  }
  if (slowThresholdMs !== null && entry.durationMs >= slowThresholdMs) {
    return { className: 'bg-amber-500 dark:bg-amber-600', striped: false, pulsing: false };
  }
  if (entry.status === 'skipped') {
    return { className: 'bg-muted-foreground/40', striped: false, pulsing: false };
  }
  return { className: 'bg-primary', striped: false, pulsing: false };
}

export function ExecutionTimelineStrip({
  trace,
  onSelectStep,
  highlightedStepId,
}: ExecutionTimelineStripProps): React.ReactElement | null {
  // Hooks must run before the conditional return below.
  const [unit, setUnit] = React.useState<DurationUnit>('ms');

  if (trace.length < 2) return null;

  const maxDuration = trace.reduce((m, e) => Math.max(m, e.durationMs), 0);
  const slowThreshold = slowOutlierThresholdMs(trace);
  const parallelBranchMap = buildParallelBranchMap(trace);

  // ─── Gantt timeline ─────────────────────────────────────────────────────
  // Bars are positioned on a shared wall-clock axis so parallel branches
  // visibly overlap, not stack left-aligned. We derive the axis from the
  // trace itself: execStart = earliest startedAt, execEnd = latest
  // completedAt (or startedAt + durationMs for entries still in flight).
  // If the trace has no usable timestamps OR everything happened in a
  // single instant, we fall back to the legacy "width proportional to
  // maxDuration, left-aligned" rendering so the strip stays useful for
  // older traces and degenerate cases.
  const startTimes: number[] = [];
  const endTimes: number[] = [];
  for (const e of trace) {
    const s = e.startedAt ? new Date(e.startedAt).getTime() : NaN;
    if (Number.isFinite(s)) {
      startTimes.push(s);
      const end = e.completedAt ? new Date(e.completedAt).getTime() : s + Math.max(0, e.durationMs);
      if (Number.isFinite(end)) endTimes.push(end);
    }
  }
  const execStart = startTimes.length > 0 ? Math.min(...startTimes) : NaN;
  const execEnd = endTimes.length > 0 ? Math.max(...endTimes) : NaN;
  const totalSpan =
    Number.isFinite(execStart) && Number.isFinite(execEnd) ? execEnd - execStart : 0;
  const useGantt = totalSpan > 0;

  // Stable lookup: parallel-fork step → short label index (#1, #2, …) so a
  // branch row can reference its parent without taking up much horizontal room.
  const parallelForkIndex = new Map<string, number>();
  trace.forEach((entry) => {
    if (entry.stepType === 'parallel' && !parallelForkIndex.has(entry.stepId)) {
      parallelForkIndex.set(entry.stepId, parallelForkIndex.size + 1);
    }
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            Step timeline
            <FieldHelp title="Reading the timeline">
              <p>
                A Gantt-style view of the run on a shared wall-clock axis. The left edge is the
                first step&apos;s start; the right edge is the last step&apos;s end. Each bar&apos;s
                horizontal position shows when its step ran; its width shows how long. Steps that
                ran at the same time stack vertically and overlap horizontally.
              </p>
              <p className="text-foreground mt-2 font-medium">Order</p>
              <p>
                Rows run top-to-bottom in the order the engine entered each step. Bars themselves
                are placed by wall-clock time, so a fork&apos;s branches sit on top of each other.
              </p>
              <p className="text-foreground mt-2 font-medium">Status icons</p>
              <p>
                ✓ completed · ✕ failed or rejected · ⏵ skipped · ⏲ awaiting approval · ↻ running
                (pulsing bar). Hover any icon for the label.
              </p>
              <p className="text-foreground mt-2 font-medium">Colours</p>
              <p>
                <span className="text-red-600 dark:text-red-400">Red</span> — failed.{' '}
                <span className="text-amber-500">Amber</span> — slow outlier (≥ 90th percentile) or
                awaiting approval. <span className="text-primary">Primary</span> — completed.
                Translucent grey — skipped.
              </p>
              <p className="text-foreground mt-2 font-medium">Parallel steps</p>
              <p>
                A <span className="text-purple-600 dark:text-purple-400">Fork #N</span> chip marks a
                parallel step that fans out concurrent branches. Each immediate branch is indented
                with a purple bar on the left and tagged <span className="font-mono">∥N</span>,
                indicating which fork it belongs to. Branch bars typically share a left edge with
                the fork — that&apos;s the visual signal of concurrency.
              </p>
              <p className="text-foreground mt-2 font-medium">Interaction</p>
              <p>Click any bar to jump to that step in the trace below.</p>
            </FieldHelp>
            {useGantt && (
              <span
                data-testid="timeline-wall-clock"
                className="text-muted-foreground ml-1 text-[11px] font-normal"
                title="Total wall-clock duration of the execution"
              >
                · wall-clock {formatDuration(totalSpan, unit)}
              </span>
            )}
          </CardTitle>
          <div
            role="group"
            aria-label="Duration unit"
            className="border-border inline-flex overflow-hidden rounded-md border text-[11px]"
          >
            {(['ms', 's'] as const).map((u) => {
              const active = unit === u;
              return (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUnit(u)}
                  aria-pressed={active}
                  data-testid={`timeline-unit-${u}`}
                  className={cn(
                    'px-2 py-0.5 font-mono transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted/60'
                  )}
                >
                  {u}
                </button>
              );
            })}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div
          className="flex gap-2"
          aria-label="Step duration timeline"
          data-testid="execution-timeline-strip"
        >
          <div className="flex-1 space-y-1">
            {trace.map((entry, idx) => {
              const isRunning = (entry.status as string) === 'running';
              // Gantt geometry — position on the shared wall-clock axis.
              const entryStart = entry.startedAt ? new Date(entry.startedAt).getTime() : NaN;
              let leftPct = 0;
              let widthPct: number;
              if (useGantt && Number.isFinite(entryStart)) {
                leftPct = Math.max(0, Math.min(100, ((entryStart - execStart) / totalSpan) * 100));
                const rawWidth = (entry.durationMs / totalSpan) * 100;
                // Floor short steps to 0.5% so they're still visible as a
                // tick mark; cap so the bar can't extend past the axis.
                widthPct = Math.max(0.5, Math.min(100 - leftPct, rawWidth));
              } else {
                // Legacy left-aligned fallback (no usable timestamps or
                // single-instant trace).
                const rawPct = maxDuration > 0 ? (entry.durationMs / maxDuration) * 100 : 25;
                widthPct = isRunning ? Math.min(100, Math.max(rawPct, 25)) : rawPct;
              }
              const { className: colourClass, striped, pulsing } = barColour(entry, slowThreshold);
              const isHighlighted = highlightedStepId === entry.stepId;
              const statusMeta = STATUS_ICON[entry.status as string] ?? STATUS_ICON.completed;
              const StatusIcon = statusMeta.Icon;
              const isFork = entry.stepType === 'parallel';
              const forkNumber = isFork ? parallelForkIndex.get(entry.stepId) : undefined;
              const parentForkStepId = parallelBranchMap.get(entry.stepId);
              const parentForkNumber = parentForkStepId
                ? parallelForkIndex.get(parentForkStepId)
                : undefined;
              return (
                <button
                  type="button"
                  key={`${entry.stepId}-${idx}`}
                  aria-label={`Step ${idx + 1}: ${entry.label} — ${statusMeta.label} — ${formatDuration(entry.durationMs, unit)}${
                    parentForkNumber ? ` — parallel branch of fork #${parentForkNumber}` : ''
                  }${isFork ? ` — parallel fork #${forkNumber}` : ''}`}
                  data-testid={`timeline-bar-${entry.stepId}`}
                  data-status={entry.status}
                  data-slow={
                    slowThreshold !== null && entry.durationMs >= slowThreshold ? 'true' : 'false'
                  }
                  data-parallel-parent={parentForkStepId ?? undefined}
                  data-parallel-fork={isFork ? 'true' : undefined}
                  onClick={() => onSelectStep?.(entry.stepId)}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded py-0.5 text-left text-xs transition-colors',
                    'hover:bg-muted/50 focus-visible:outline-primary focus-visible:outline-2 focus-visible:outline-offset-2',
                    isHighlighted && 'bg-muted/60'
                  )}
                >
                  <span className="text-muted-foreground/70 w-6 shrink-0 text-right font-mono tabular-nums">
                    {idx + 1}.
                  </span>
                  <span className="shrink-0" title={statusMeta.label} aria-hidden="true">
                    <StatusIcon className={cn('h-3.5 w-3.5', statusMeta.className)} />
                  </span>
                  <span
                    className={cn(
                      'flex w-96 shrink-0 flex-wrap items-center gap-1',
                      parentForkNumber &&
                        'border-l-2 border-purple-400 pl-1.5 dark:border-purple-600'
                    )}
                  >
                    {isFork && (
                      <span
                        className="flex items-center gap-0.5 rounded bg-purple-100 px-1 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-950/60 dark:text-purple-300"
                        title={`Parallel fork #${forkNumber} — branches run concurrently`}
                      >
                        <GitBranch className="h-2.5 w-2.5" />
                        Fork #{forkNumber}
                      </span>
                    )}
                    {parentForkNumber !== undefined && (
                      <span
                        className="text-[10px] text-purple-700 dark:text-purple-300"
                        title={`Concurrent branch of parallel fork #${parentForkNumber}`}
                      >
                        ∥{parentForkNumber}
                      </span>
                    )}
                    <span
                      className="text-muted-foreground min-w-0 flex-1 font-mono break-words"
                      title={entry.label}
                    >
                      {entry.label}
                    </span>
                  </span>
                  <span className="bg-muted/30 relative h-4 flex-1 overflow-hidden rounded">
                    <span
                      data-testid={`timeline-bar-fill-${entry.stepId}`}
                      className={cn(
                        'absolute inset-y-0 transition-[width,left]',
                        colourClass,
                        striped &&
                          'bg-[image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(0,0,0,0.15)_4px,rgba(0,0,0,0.15)_8px)]',
                        pulsing && 'animate-pulse'
                      )}
                      style={{
                        left: `${leftPct.toFixed(2)}%`,
                        width: `${widthPct.toFixed(2)}%`,
                      }}
                    />
                  </span>
                  <span className="text-muted-foreground w-20 shrink-0 text-right tabular-nums">
                    {formatDuration(entry.durationMs, unit)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
