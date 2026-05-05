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

import type { ExecutionTraceEntry, LlmTelemetryEntry } from '@/types/orchestration';

/**
 * Roll a list of per-turn telemetry entries into the optional fields
 * carried on the trace entry.
 *
 * - Returns an object with only the fields that have meaningful values.
 *   Empty input → `{}` so spreading into a trace entry is a no-op.
 * - `model` / `provider` come from the LAST turn — for multi-turn
 *   executors this is the model that produced the step's final output.
 * - Tokens and duration are summed across turns.
 */
export function rollupTelemetry(entries: LlmTelemetryEntry[]): {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  llmDurationMs?: number;
} {
  if (entries.length === 0) return {};

  let inputTokens = 0;
  let outputTokens = 0;
  let llmDurationMs = 0;
  for (const entry of entries) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    llmDurationMs += entry.durationMs;
  }

  const last = entries[entries.length - 1];
  return {
    model: last.model,
    provider: last.provider,
    inputTokens,
    outputTokens,
    llmDurationMs,
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
