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

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getStepMetadata, type StepCategory } from '@/lib/orchestration/engine/step-registry';

type DurationUnit = 'ms' | 's';

function formatDuration(ms: number, unit: DurationUnit): string {
  if (unit === 's') {
    // Two decimals keeps sub-second steps readable (e.g. 0.04 s) without
    // losing precision for short steps that would otherwise round to 0.
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return `${ms.toLocaleString()} ms`;
}

/**
 * Render `ms` as `HH:MM:SS`. Used alongside the raw ms/s value on the
 * wall-clock chip so long runs are scannable without mental math
 * (80,179 ms ≈ "is that ~80 seconds or ~80 minutes?"). Caller is
 * responsible for hiding it on sub-second totals where it's just noise.
 */
function formatHMS(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
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

// Solid bar colours per step-type category, matching the workflow builder's
// `STEP_CATEGORY_COLOURS` palette tonally but stronger so they read against
// the bar-lane background. Status takes over for failed/rejected/running/
// skipped/awaiting — those are operational signals that out-rank the
// authoring-time category colour.
const CATEGORY_BAR_BG: Record<StepCategory, string> = {
  orchestration: 'bg-purple-500 dark:bg-purple-600',
  agent: 'bg-blue-500 dark:bg-blue-600',
  decision: 'bg-amber-500 dark:bg-amber-600',
  output: 'bg-emerald-500 dark:bg-emerald-600',
  input: 'bg-slate-500 dark:bg-slate-500',
};

const UNKNOWN_CATEGORY_BG = 'bg-muted-foreground/60';

const STRIPED_AMBER =
  'bg-[image:repeating-linear-gradient(45deg,rgb(251,191,36)_0_4px,rgb(217,119,6)_4px_8px)]';
const HASHED_COMPRESSED =
  'bg-[image:repeating-linear-gradient(135deg,rgba(251,191,36,0.7)_0_3px,rgba(120,53,15,0.5)_3px_6px)]';

function barAppearance(entry: ExecutionTraceEntry): {
  className: string;
  striped: boolean;
  pulsing: boolean;
  category: StepCategory | null;
} {
  const category = getStepMetadata(entry.stepType)?.category ?? null;

  // Status overrides (operational > authoring).
  if ((entry.status as string) === 'running') {
    return { className: 'bg-primary/70', striped: false, pulsing: true, category };
  }
  if (entry.status === 'failed' || entry.status === 'rejected') {
    return { className: 'bg-red-500 dark:bg-red-600', striped: false, pulsing: false, category };
  }
  if (entry.status === 'awaiting_approval') {
    return { className: STRIPED_AMBER, striped: true, pulsing: false, category };
  }
  if (entry.status === 'skipped') {
    return {
      className: 'bg-muted-foreground/30 opacity-60',
      striped: false,
      pulsing: false,
      category,
    };
  }

  // Default: step-type category colour.
  return {
    className: category ? CATEGORY_BAR_BG[category] : UNKNOWN_CATEGORY_BG,
    striped: false,
    pulsing: false,
    category,
  };
}

function formatHoverTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Locale time with seconds. The full ISO is kept in the title attribute
  // for copy-paste, but the human-readable form is what shows in the chip.
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function ExecutionTimelineStrip({
  trace,
  onSelectStep,
  highlightedStepId,
}: ExecutionTimelineStripProps): React.ReactElement | null {
  // Hooks must run before the conditional return below.
  const [unit, setUnit] = React.useState<DurationUnit>('ms');
  // Approval-wait compression. `manualCompressWaits` records the user's
  // explicit click; `null` means follow the auto-default derived from the
  // trace (compress whenever an awaiting_approval bar would otherwise
  // dominate >50% of the wall-clock axis). The effective flag is computed
  // below so the auto-default reacts to live-polled trace changes until
  // the user makes a choice.
  const [manualCompressWaits, setManualCompressWaits] = React.useState<boolean | null>(null);

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
  // When compressWaits is on, awaiting_approval steps collapse to a
  // fixed-duration placeholder and following steps shift left to close
  // the gap. Awaiting steps pause the workflow, so any subsequent step's
  // raw startedAt is strictly after the awaiting end — safe to subtract
  // savings from each later step's start without disturbing concurrency.
  const COMPRESSED_WAIT_MS = 1_000;
  /** Auto-default kicks in when an awaiting wait would dominate ≥ this share of the axis. */
  const AUTO_COMPRESS_THRESHOLD = 0.5;

  const rawStartByEntry = trace.map((e) => (e.startedAt ? new Date(e.startedAt).getTime() : NaN));
  const rawEndByEntry = trace.map((e, i) => {
    const s = rawStartByEntry[i];
    if (!Number.isFinite(s)) return NaN;
    if (e.completedAt) {
      const c = new Date(e.completedAt).getTime();
      if (Number.isFinite(c)) return c;
    }
    return s + Math.max(0, e.durationMs);
  });

  // Auto-default for compression — derived from the uncompressed axis.
  // If any awaiting_approval bar would take more than half of the
  // wall-clock span, default to compressed until the user toggles off.
  const finiteRawStarts = rawStartByEntry.filter((n) => Number.isFinite(n));
  const finiteRawEnds = rawEndByEntry.filter((n) => Number.isFinite(n));
  const rawTotalSpan =
    finiteRawStarts.length > 0 && finiteRawEnds.length > 0
      ? Math.max(...finiteRawEnds) - Math.min(...finiteRawStarts)
      : 0;
  const longestAwaitMs = trace.reduce((max, e, i) => {
    if (e.status !== 'awaiting_approval') return max;
    const s = rawStartByEntry[i];
    const en = rawEndByEntry[i];
    if (!Number.isFinite(s) || !Number.isFinite(en)) return max;
    return Math.max(max, en - s);
  }, 0);
  const shouldAutoCompress =
    rawTotalSpan > 0 && longestAwaitMs / rawTotalSpan >= AUTO_COMPRESS_THRESHOLD;
  const compressWaits = manualCompressWaits ?? shouldAutoCompress;

  const savingsByEntry = trace.map(() => 0);
  if (compressWaits) {
    for (let i = 0; i < trace.length; i++) {
      const myStart = rawStartByEntry[i];
      if (!Number.isFinite(myStart)) continue;
      let saved = 0;
      for (let j = 0; j < trace.length; j++) {
        if (j === i) continue;
        if (trace[j].status !== 'awaiting_approval') continue;
        const otherEnd = rawEndByEntry[j];
        const otherStart = rawStartByEntry[j];
        if (!Number.isFinite(otherEnd) || !Number.isFinite(otherStart) || otherEnd > myStart) {
          continue;
        }
        const otherDur = otherEnd - otherStart;
        saved += Math.max(0, otherDur - COMPRESSED_WAIT_MS);
      }
      savingsByEntry[i] = saved;
    }
  }

  interface BarTiming {
    /** ms position on the compressed axis (NaN when no timestamps). */
    start: number;
    end: number;
    /** Original (uncompressed) duration kept for labels/aria. */
    originalDurationMs: number;
    /** True when this row's width was overridden by compression. */
    compressed: boolean;
  }

  const timings: BarTiming[] = trace.map((e, i) => {
    const rawStart = rawStartByEntry[i];
    const rawEnd = rawEndByEntry[i];
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      return { start: NaN, end: NaN, originalDurationMs: e.durationMs, compressed: false };
    }
    const originalDur = rawEnd - rawStart;
    const compressed = compressWaits && e.status === 'awaiting_approval';
    const displayDur = compressed ? COMPRESSED_WAIT_MS : originalDur;
    const shiftedStart = rawStart - savingsByEntry[i];
    return {
      start: shiftedStart,
      end: shiftedStart + displayDur,
      originalDurationMs: originalDur,
      compressed,
    };
  });

  const finiteCompressedStarts = timings.map((t) => t.start).filter((n) => Number.isFinite(n));
  const finiteCompressedEnds = timings.map((t) => t.end).filter((n) => Number.isFinite(n));
  const execStart = finiteCompressedStarts.length > 0 ? Math.min(...finiteCompressedStarts) : NaN;
  const execEnd = finiteCompressedEnds.length > 0 ? Math.max(...finiteCompressedEnds) : NaN;
  const totalSpan =
    Number.isFinite(execStart) && Number.isFinite(execEnd) ? execEnd - execStart : 0;
  const useGantt = totalSpan > 0;
  const hasAwaitingSteps = trace.some((e) => e.status === 'awaiting_approval');

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
              <p className="text-foreground mt-2 font-medium">Bar colours</p>
              <p>
                Each bar takes the colour of its step type&apos;s category — matching the
                workflow-builder palette:
                <span className="text-purple-600 dark:text-purple-400"> purple</span> orchestration,
                <span className="text-blue-600 dark:text-blue-400"> blue</span> agent,
                <span className="text-amber-600 dark:text-amber-400"> amber</span> decision,
                <span className="text-emerald-600 dark:text-emerald-400"> emerald</span> output,
                <span className="text-slate-600 dark:text-slate-300"> slate</span> input. Status
                overrides the category colour when it matters operationally:{' '}
                <span className="text-red-600 dark:text-red-400">red</span> failed or rejected,
                amber stripes awaiting approval, primary pulsing running, faded grey skipped.
              </p>
              <p className="text-foreground mt-2 font-medium">Parallel steps</p>
              <p>
                A <span className="text-indigo-600 dark:text-indigo-400">Fork #N</span> chip marks a
                parallel step that fans out concurrent branches. Each immediate branch is indented
                with an indigo bar on the left and tagged <span className="font-mono">∥N</span>,
                indicating which fork it belongs to. Branch bars typically share a left edge with
                the fork — that&apos;s the visual signal of concurrency. (Indigo is reserved for
                this structural accent; purple bars are reserved for the orchestrator step type.)
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
                {totalSpan >= 1000 && (
                  <span className="ml-1 font-mono">({formatHMS(totalSpan)})</span>
                )}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {hasAwaitingSteps && (
              <button
                type="button"
                onClick={() => setManualCompressWaits(!compressWaits)}
                aria-pressed={compressWaits}
                data-testid="timeline-compress-waits"
                data-auto-compressed={
                  manualCompressWaits === null && shouldAutoCompress ? 'true' : undefined
                }
                title={
                  compressWaits
                    ? 'Showing compressed approval waits — click to restore real durations' +
                      (manualCompressWaits === null && shouldAutoCompress
                        ? ' (auto-enabled because an approval wait dominates the timeline)'
                        : '')
                    : 'Approval waits dominate the timeline — click to collapse them to a fixed-width marker'
                }
                className={cn(
                  'border-border inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                  compressWaits
                    ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200'
                    : 'text-muted-foreground hover:bg-muted/60'
                )}
              >
                {compressWaits ? 'Compressed waits' : 'Compress waits'}
                {manualCompressWaits === null && shouldAutoCompress && (
                  <span className="text-amber-700/70 dark:text-amber-300/70">· auto</span>
                )}
              </button>
            )}
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
        </div>
      </CardHeader>
      <CardContent>
        <TooltipProvider delayDuration={200}>
          <div
            className="flex gap-2"
            aria-label="Step duration timeline"
            data-testid="execution-timeline-strip"
          >
            <div className="flex-1 space-y-1">
              {trace.map((entry, idx) => {
                const isRunning = (entry.status as string) === 'running';
                const timing = timings[idx];

                // Position on the (possibly compressed) shared wall-clock axis.
                let leftPct = 0;
                let widthPct: number;
                if (useGantt && Number.isFinite(timing.start)) {
                  leftPct = Math.max(
                    0,
                    Math.min(100, ((timing.start - execStart) / totalSpan) * 100)
                  );
                  const displayDur = timing.end - timing.start;
                  const rawWidth = (displayDur / totalSpan) * 100;
                  // Floor short steps to 0.5% so they're still visible.
                  widthPct = Math.max(0.5, Math.min(100 - leftPct, rawWidth));
                } else {
                  // Legacy left-aligned fallback (no usable timestamps or
                  // single-instant trace).
                  const rawPct = maxDuration > 0 ? (entry.durationMs / maxDuration) * 100 : 25;
                  widthPct = isRunning ? Math.min(100, Math.max(rawPct, 25)) : rawPct;
                }

                const { className: colourClass, striped, pulsing, category } = barAppearance(entry);
                const isCompressedAwait = timing.compressed;
                const isHighlighted = highlightedStepId === entry.stepId;
                const statusMeta = STATUS_ICON[entry.status as string] ?? STATUS_ICON.completed;
                const StatusIcon = statusMeta.Icon;
                const isFork = entry.stepType === 'parallel';
                const forkNumber = isFork ? parallelForkIndex.get(entry.stepId) : undefined;
                const parentForkStepId = parallelBranchMap.get(entry.stepId);
                const parentForkNumber = parentForkStepId
                  ? parallelForkIndex.get(parentForkStepId)
                  : undefined;
                const meta = getStepMetadata(entry.stepType);
                const friendlyType = meta?.label ?? entry.stepType;
                const description = meta?.description ?? null;
                const startedLabel = formatHoverTime(entry.startedAt);
                const endedLabel = entry.completedAt
                  ? formatHoverTime(entry.completedAt)
                  : isRunning
                    ? '(running)'
                    : '—';
                // Display the wall-clock elapsed (from timestamps) so the
                // bar's visual length and the duration text agree. For
                // awaiting_approval steps in particular `entry.durationMs`
                // is the executor's own processing time (typically ~1ms
                // for an approval click), which would otherwise mismatch
                // the wide pause bar drawn on the axis. The timestamp
                // delta is computed in `timing.originalDurationMs`; fall
                // back to `entry.durationMs` when timestamps are absent.
                const realDurationMs = Number.isFinite(timing.originalDurationMs)
                  ? timing.originalDurationMs
                  : entry.durationMs;

                return (
                  <Tooltip key={`${entry.stepId}-${idx}`}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Step ${idx + 1}: ${entry.label} — ${statusMeta.label} — ${formatDuration(realDurationMs, unit)}${
                          parentForkNumber ? ` — parallel branch of fork #${parentForkNumber}` : ''
                        }${isFork ? ` — parallel fork #${forkNumber}` : ''}`}
                        data-testid={`timeline-bar-${entry.stepId}`}
                        data-status={entry.status}
                        data-slow={
                          slowThreshold !== null && entry.durationMs >= slowThreshold
                            ? 'true'
                            : 'false'
                        }
                        data-parallel-parent={parentForkStepId ?? undefined}
                        data-parallel-fork={isFork ? 'true' : undefined}
                        data-category={category ?? undefined}
                        data-compressed={isCompressedAwait ? 'true' : undefined}
                        onClick={() => onSelectStep?.(entry.stepId)}
                        className={cn(
                          'group flex w-full items-center gap-2 py-0.5 text-left text-xs transition-colors',
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
                            // Indigo, not purple — purple is reserved for the
                            // orchestrator step-type bar fill so the fork/branch
                            // accent has to read distinctly.
                            parentForkNumber &&
                              'border-l-2 border-indigo-400 pl-1.5 dark:border-indigo-600'
                          )}
                        >
                          {isFork && (
                            <span
                              className="flex items-center gap-0.5 bg-indigo-100 px-1 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
                              title={`Parallel fork #${forkNumber} — branches run concurrently`}
                            >
                              <GitBranch className="h-2.5 w-2.5" />
                              Fork #{forkNumber}
                            </span>
                          )}
                          {parentForkNumber !== undefined && (
                            <span
                              className="text-[10px] text-indigo-700 dark:text-indigo-300"
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
                        <span className="bg-muted/30 relative h-4 flex-1 overflow-hidden">
                          <span
                            data-testid={`timeline-bar-fill-${entry.stepId}`}
                            className={cn(
                              'absolute inset-y-0 transition-[width,left]',
                              isCompressedAwait ? HASHED_COMPRESSED : colourClass,
                              !isCompressedAwait &&
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
                          {formatDuration(realDurationMs, unit)}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs text-left">
                      <p className="font-medium">{entry.label}</p>
                      <p className="text-primary-foreground/70 mt-0.5 font-mono text-[10px] tracking-wide uppercase">
                        {friendlyType}
                      </p>
                      {description && (
                        <p className="text-primary-foreground/85 mt-1 text-[11px] leading-snug">
                          {description}
                        </p>
                      )}
                      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                        <dt className="text-primary-foreground/70">Status</dt>
                        <dd>
                          {statusMeta.label}
                          {isCompressedAwait && ' (wait compressed for display)'}
                        </dd>
                        <dt className="text-primary-foreground/70">Started</dt>
                        <dd>{startedLabel}</dd>
                        <dt className="text-primary-foreground/70">Ended</dt>
                        <dd>{endedLabel}</dd>
                        <dt className="text-primary-foreground/70">Duration</dt>
                        <dd>{formatDuration(realDurationMs, unit)}</dd>
                        {/* The trace row below the bar shows this same
                            reason inline; the tooltip is useful when the
                            operator is scanning bars in the Gantt and
                            hasn't scrolled the matching row into view. */}
                        {entry.status === 'skipped' && (
                          <>
                            <dt className="text-primary-foreground/70">Reason</dt>
                            <dd className="break-words">{entry.error ?? 'no reason captured'}</dd>
                          </>
                        )}
                      </dl>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
