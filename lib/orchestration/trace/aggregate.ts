/**
 * Trace telemetry aggregation helpers.
 *
 * The engine collects per-LLM-turn telemetry into an array during step
 * execution (see `ExecutionContext.stepTelemetry`). After the executor
 * returns, the engine rolls those entries up into the optional
 * `model` / `provider` / `inputTokens` / `outputTokens` / `llmDurationMs`
 * fields on the step's trace entry.
 *
 * Phase 3 (timeline strip + aggregates UI) and Phase 4 (per-step detail +
 * filters) also consume aggregates, computed from the persisted trace —
 * those helpers live here too so the engine and the UI share one
 * implementation.
 */

import type {
  ExecutionTraceEntry,
  LlmRequestParamsSnapshot,
  LlmTelemetryEntry,
} from '@/types/orchestration';

/**
 * Roll a list of per-turn telemetry entries into the optional fields
 * carried on the trace entry.
 *
 * - Returns an object with only the fields that have meaningful values.
 *   Empty input → `{}` so spreading into a trace entry is a no-op.
 * - Tokens and duration are summed across ALL turns (planner + any
 *   delegations) so the trace row's totals reflect the full work the
 *   step did, including sub-agent calls invoked from inside.
 * - `model` / `provider` / `requestParams` come from the LAST turn —
 *   **unless** at least one entry is tagged `source: 'planner'`, in
 *   which case the last *planner* entry wins. This carve-out is for
 *   orchestrator-style steps where delegations push to the SAME
 *   telemetry array as the planner; without it the trace's headline
 *   identity would shift to whichever delegation happened to run last,
 *   not the step's own primary work. For every other step type, no
 *   entries are tagged and the behaviour is "last entry wins" exactly
 *   as before this tag existed.
 */
export function rollupTelemetry(entries: LlmTelemetryEntry[]): {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  llmDurationMs?: number;
  requestParams?: LlmRequestParamsSnapshot;
} {
  if (entries.length === 0) return {};

  let inputTokens = 0;
  let outputTokens = 0;
  let llmDurationMs = 0;
  let lastPlanner: LlmTelemetryEntry | undefined;
  for (const entry of entries) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    llmDurationMs += entry.durationMs;
    if (entry.source === 'planner') lastPlanner = entry;
  }

  // Prefer the last planner entry for the headline fields when any
  // exists — single-call steps don't tag their entries, so they fall
  // through to the original "last entry wins" path.
  const headline = lastPlanner ?? entries[entries.length - 1];
  return {
    model: headline.model,
    provider: headline.provider,
    inputTokens,
    outputTokens,
    llmDurationMs,
    ...(headline.requestParams ? { requestParams: headline.requestParams } : {}),
  };
}

/**
 * Computed summary across an entire execution trace. Powers the
 * aggregates card on the execution detail page (Phase 3).
 *
 * - `stepTimeSumMs` is the sum of `durationMs` across all entries. It is
 *   NOT wall-clock: for workflows with parallel branches it exceeds the
 *   actual run duration (the engine reports each branch's full duration
 *   even though they ran concurrently). True wall-clock comes from
 *   `execution.startedAt`/`completedAt` and is shown in the summary cards
 *   above the aggregates card.
 * - p50 / p95 are computed via the standard "nearest-rank" method on
 *   `durationMs`. For traces with < 2 entries, returns `null` — callers
 *   should hide the aggregate row in that case.
 * - `slowestStep` is the entry with the largest `durationMs`. Ties are
 *   broken by the first-seen order so admins can match against a specific
 *   step.
 */
export interface TraceAggregates {
  /**
   * Sum of per-step `durationMs`. NOT wall-clock — parallel branches each
   * contribute their full duration. UI label: "Step time sum".
   */
  stepTimeSumMs: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  slowestStep: { stepId: string; label: string; durationMs: number } | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLlmDurationMs: number;
  byStepType: Record<string, { count: number; tokens: number; durationMs: number }>;
}

export function computeTraceAggregates(trace: ExecutionTraceEntry[]): TraceAggregates {
  if (trace.length === 0) {
    return {
      stepTimeSumMs: 0,
      p50DurationMs: null,
      p95DurationMs: null,
      slowestStep: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalLlmDurationMs: 0,
      byStepType: {},
    };
  }

  let stepTimeSumMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLlmDurationMs = 0;
  let slowestIdx = 0;
  const byStepType: Record<string, { count: number; tokens: number; durationMs: number }> = {};

  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i];
    stepTimeSumMs += entry.durationMs;
    totalInputTokens += entry.inputTokens ?? 0;
    totalOutputTokens += entry.outputTokens ?? 0;
    totalLlmDurationMs += entry.llmDurationMs ?? 0;

    if (entry.durationMs > trace[slowestIdx].durationMs) slowestIdx = i;

    const bucket = byStepType[entry.stepType] ?? { count: 0, tokens: 0, durationMs: 0 };
    bucket.count += 1;
    bucket.tokens += entry.tokensUsed;
    bucket.durationMs += entry.durationMs;
    byStepType[entry.stepType] = bucket;
  }

  const sorted = trace.length >= 2 ? trace.map((e) => e.durationMs).sort((a, b) => a - b) : null;

  return {
    stepTimeSumMs,
    p50DurationMs: sorted ? percentile(sorted, 50) : null,
    p95DurationMs: sorted ? percentile(sorted, 95) : null,
    slowestStep: {
      stepId: trace[slowestIdx].stepId,
      label: trace[slowestIdx].label,
      durationMs: trace[slowestIdx].durationMs,
    },
    totalInputTokens,
    totalOutputTokens,
    totalLlmDurationMs,
    byStepType,
  };
}

/**
 * Nearest-rank percentile. `sorted` MUST be ascending. `p` is in `[0, 100]`.
 *
 * For p=95 on an array of length n, the rank is `ceil(0.95 * n) - 1` (zero-indexed).
 * Returns the value at that rank.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(rank, sorted.length - 1)];
}

/**
 * Identify the duration threshold above which a step is considered a
 * slow outlier — used by the timeline strip to amber-highlight bars.
 *
 * - Returns the p90 threshold for traces with ≥ 5 entries.
 * - Returns `null` for shorter traces (highlighting outliers in a 3-step
 *   trace is statistical noise, not insight).
 */
export function slowOutlierThresholdMs(trace: ExecutionTraceEntry[]): number | null {
  if (trace.length < 5) return null;
  const sorted = trace.map((e) => e.durationMs).sort((a, b) => a - b);
  return percentile(sorted, 90);
}

/**
 * Membership map for parallel fan-out branches.
 *
 * For each `parallel` step in the trace, the executor records its
 * immediate branch children in `output.branches`. We harvest those into a
 * map of `branchStepId → parentParallelStepId` so the timeline strip and
 * detail rows can visually group siblings that ran concurrently.
 *
 * Caveat: this only captures immediate branch children. If a branch is a
 * multi-step chain, the downstream steps in that chain are not tagged —
 * the workflow graph would be needed for that.
 */
export function buildParallelBranchMap(trace: ExecutionTraceEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of trace) {
    if (entry.stepType !== 'parallel') continue;
    const out = entry.output;
    if (out === null || typeof out !== 'object') continue;
    const branches = (out as { branches?: unknown }).branches;
    if (!Array.isArray(branches)) continue;
    for (const branchId of branches) {
      if (typeof branchId === 'string') {
        map.set(branchId, entry.stepId);
      }
    }
  }
  return map;
}

/**
 * Minimal shape required to synthesise a running trace row. The
 * `useExecutionLivePoll` hook's `RunningStep` is structurally compatible,
 * but defining it locally keeps `aggregate.ts` free of any
 * client-only hook imports.
 */
export interface RunningStepRef {
  stepId: string;
  label: string;
  stepType: string;
  startedAt: string;
  completedAt: string | null;
}

/**
 * Merge persisted trace rows with synthesised "running" rows derived from
 * the live-poll endpoint's in-flight step list. Used by both the full
 * execution detail view and the compact inline progress panel (audit
 * dialog) so a `parallel` fan-out surfaces every branch simultaneously
 * instead of silently waiting for each one to persist.
 *
 * Behaviour:
 *   - Drops any persisted entry whose stepId is also reported as running.
 *     Defends against the rare tick that races the engine writing both.
 *   - When a running step's `completedAt` is set, the branch finished but
 *     the sibling batch hasn't settled yet — synth as `completed` with
 *     the real completedAt so the timeline strip can render the trailing
 *     "waited for slower siblings" segment.
 *   - When `completedAt` is null, synth as `running` with `durationMs`
 *     computed against `nowMs` (caller controls the clock so a 1Hz tick
 *     ref keeps the bar growing smoothly between server polls).
 */
export function buildDisplayTrace(
  liveTrace: ExecutionTraceEntry[],
  liveRunningSteps: readonly RunningStepRef[],
  nowMs: number
): ExecutionTraceEntry[] {
  if (liveRunningSteps.length === 0) return liveTrace;
  const runningStepIds = new Set(liveRunningSteps.map((r) => r.stepId));
  const persisted = liveTrace.filter((e) => !runningStepIds.has(e.stepId));
  const synth = liveRunningSteps.map((r) => {
    const startMs = new Date(r.startedAt).getTime();
    const completed = r.completedAt !== null;
    const endMs = completed ? new Date(r.completedAt as string).getTime() : nowMs;
    return {
      stepId: r.stepId,
      stepType: r.stepType,
      label: r.label,
      // The `status` union on persisted entries doesn't include 'running' —
      // the trace-row component locally widens it. Cast here intentionally
      // so the view-only display type stays narrow at the prop boundary.
      status: completed ? 'completed' : 'running',
      output: undefined,
      tokensUsed: 0,
      costUsd: 0,
      startedAt: r.startedAt,
      ...(completed ? { completedAt: r.completedAt as string } : {}),
      durationMs: Math.max(0, endMs - startMs),
    } as unknown as ExecutionTraceEntry;
  });
  return [...persisted, ...synth];
}
