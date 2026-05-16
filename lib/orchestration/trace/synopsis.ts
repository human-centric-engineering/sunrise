/**
 * Execution-status synopsis — pure analysis of an `AiWorkflowExecution`
 * row + its trace, producing a discriminated union that drives the
 * "what went wrong" panel at the top of the execution detail view.
 *
 * Why this exists. The execution detail page is the operator's
 * first-look surface when a run goes sideways. Today the failure
 * reason is buried inside a trace entry's `output`, the retry timeline
 * lives on each entry's `retries[]`, and skipped-step reasons are
 * scattered across the timeline. Operators routinely have to expand
 * multiple rows to understand what happened. This module pre-digests
 * the trace into one structured answer so the synopsis component can
 * render it without re-computing anything itself.
 *
 * Three failure shapes the analysis distinguishes:
 *
 *   1. **Step-level executor failure** — an executor threw with the
 *      `fail` error strategy; the trace has a row with
 *      `status === 'failed'` and `error` populated. Primary cause = that
 *      step.
 *   2. **Retry-exhaustion via fail-branch** — a step (typically a
 *      `guard`) hit its retry budget and the workflow routed to a
 *      `send_notification` with `terminalStatus: 'failed'`. No row has
 *      `status === 'failed'`; instead the upstream step's `retries[]`
 *      ends with `exhausted: true`. Primary cause = the exhausted step;
 *      headline cause = the terminalStatus author.
 *   3. **Engine-level failure** — budget exceeded, deadlock, unknown
 *      step id, abort. No failed step in the trace. Primary cause =
 *      `execution.errorMessage`; trace context is best-effort.
 *
 * The helpers are pure so they're trivially testable and shared between
 * the synopsis component, future analytics, and any export surface that
 * needs "what happened to this run" in plain English.
 */

import type { ExecutionTraceEntry } from '@/types/orchestration';

// ─── Public types ───────────────────────────────────────────────────────────

/** Minimal execution shape the helpers care about. Matches the
 * `ExecutionInfo` used by the detail view; redeclared here so this
 * module stays free of UI imports. */
export interface SynopsisExecution {
  status: string;
  errorMessage: string | null;
  currentStep: string | null;
}

/** Breakdown of skipped steps. Expected skips are explicitly opted into
 * by the workflow author via `step.config.expectedSkip` — they're part
 * of the happy path (optional enrichment, missing API key) and shouldn't
 * raise alarm. Unexpected skips come from `errorStrategy: 'skip'`
 * absorbing an executor error and ARE worth surfacing. */
export interface SkipBreakdown {
  total: number;
  expected: ExecutionTraceEntry[];
  unexpected: ExecutionTraceEntry[];
}

/** Where the workflow was looking immediately before it failed. Helps
 * operators see what input fed the bad outcome without scrolling the
 * trace. */
export interface PredecessorContext {
  stepId: string;
  stepName: string;
  output: unknown;
}

/** A retry exhaustion event surfaced from any trace entry's
 * `retries[]`. Used to find the root cause when the headline failure
 * sits downstream (e.g. a `send_notification` terminalStatus author
 * that fires AFTER the actual culprit exhausted its retries). */
export interface ExhaustedRetry {
  /** The step whose retry budget exhausted. */
  step: ExecutionTraceEntry;
  /** Number of attempts the engine made (the `attempt` field of the
   * exhaustion event — typically one more than `maxRetries`). */
  attempts: number;
  maxRetries: number;
  /** The failure reason on the final attempt. */
  reason: string;
  /** Where the engine routed after exhaustion (the fallback edge
   * target — often the terminalStatus author). */
  targetStepId: string;
}

/** Discriminated synopsis result. `kind: 'none'` means the run
 * succeeded cleanly with no notable skips — render nothing. */
export type SynopsisAnalysis =
  | { kind: 'none' }
  | {
      kind: 'failure';
      /** The single user-facing reason, plain text. Always non-empty.
       * For step failures this is the trace entry's `error`; for
       * retry-exhaustion it's the final attempt's reason; for
       * engine-level failures it's `execution.errorMessage`. */
      reason: string;
      /** The step shown in the headline — what an operator should
       * click on first. For step failures this is the failing entry;
       * for retry-exhaustion it's the exhausted step (NOT the
       * terminalStatus author, which is just the messenger). Null when
       * the failure is engine-level and no trace step is the culprit. */
      headlineStep: ExecutionTraceEntry | null;
      /** Retry history if the headline step retried. Empty array if
       * the step didn't retry. */
      retries: NonNullable<ExecutionTraceEntry['retries']>;
      /** Most recent completed step's output, for "what was this
       * looking at" context. Null when no predecessor is available
       * (failure at step 0, or no completed steps). */
      predecessor: PredecessorContext | null;
      /** Skip breakdown for the run — sometimes a failure happens
       * alongside skips and the operator wants both signals. */
      skips: SkipBreakdown;
      /** When the headline step is a retry-exhaustion (not a thrown
       * error), this names the terminalStatus author that finalised
       * the workflow as FAILED. Lets the synopsis explain the
       * cause-and-effect: "Exhausted retries at X → workflow failed
       * via terminalStatus on Y". */
      terminalAuthor: ExecutionTraceEntry | null;
    }
  | {
      kind: 'cancellation';
      /** Reason from `execution.errorMessage` — typically "Rejected:
       * <admin notes>" for human-approval rejections or "Execution
       * cancelled by user" for explicit cancels. */
      reason: string;
      /** Step the engine was on when cancellation hit. */
      atStep: ExecutionTraceEntry | null;
    }
  | {
      kind: 'skips_only';
      /** Always has at least one UNEXPECTED skip — fully-expected
       * skip runs collapse to `kind: 'none'`. */
      skips: SkipBreakdown;
    };

// ─── Implementation ─────────────────────────────────────────────────────────

/**
 * Walk a workflow execution + trace and return the synopsis kind.
 * Pure function — no DB reads, no side effects.
 */
export function analyzeExecution(
  execution: SynopsisExecution,
  trace: ExecutionTraceEntry[]
): SynopsisAnalysis {
  const status = (execution.status ?? '').toLowerCase();
  const skips = tallySkips(trace);

  if (status === 'failed') {
    return buildFailureAnalysis(execution, trace, skips);
  }

  if (status === 'cancelled' || status === 'canceled') {
    return {
      kind: 'cancellation',
      reason: nonEmpty(execution.errorMessage) ?? 'Cancelled',
      atStep: findStepById(trace, execution.currentStep),
    };
  }

  // status === 'completed' (or paused/running/etc.) — only surface a
  // synopsis when there are unexpected skips. Expected skips are
  // routine and would clutter the happy path.
  if (skips.unexpected.length > 0) {
    return { kind: 'skips_only', skips };
  }

  return { kind: 'none' };
}

/**
 * Find the trace entry whose `status === 'failed'` — the step-level
 * executor-throw path. Returns null when no such entry exists (engine
 * failure or retry-exhaustion + terminalStatus path).
 */
export function findFailedStep(trace: ExecutionTraceEntry[]): ExecutionTraceEntry | null {
  return trace.find((e) => e.status === 'failed') ?? null;
}

/**
 * Walk the trace looking for a step whose retry budget exhausted.
 * Returns the LAST such event (closest to the workflow's terminal
 * status, which is usually what the operator cares about — the most
 * recent root cause). Returns null when no exhaustion occurred.
 *
 * The retries[] array on each trace entry may contain multiple
 * attempts; the exhaustion event is the one with `exhausted: true`,
 * always the final element by construction.
 */
export function findExhaustedRetry(trace: ExecutionTraceEntry[]): ExhaustedRetry | null {
  // Walk in reverse so the most recent exhaustion wins when multiple
  // steps in a long workflow have exhausted retries.
  for (let i = trace.length - 1; i >= 0; i--) {
    const entry = trace[i];
    const retries = entry.retries;
    if (!retries || retries.length === 0) continue;
    const last = retries[retries.length - 1];
    if (last?.exhausted) {
      return {
        step: entry,
        attempts: last.attempt,
        maxRetries: last.maxRetries,
        reason: last.reason ?? '',
        targetStepId: last.targetStepId,
      };
    }
  }
  return null;
}

/**
 * Walk the trace backwards from `failingStepId` (or from the end if
 * unspecified) and return the most recent successfully-completed
 * step whose output is non-null. Lets the synopsis show "what was
 * this step looking at" without the operator scrolling.
 *
 * Skipped steps are not considered predecessors — their output is
 * usually null/empty and they don't represent fed data.
 */
export function findPredecessorContext(
  trace: ExecutionTraceEntry[],
  failingStepId: string | null
): PredecessorContext | null {
  // Locate the failing step's position in the trace. If it's not
  // there (engine-level failure with no trace row), start from the
  // very end.
  let startIdx = trace.length - 1;
  if (failingStepId) {
    const idx = trace.findIndex((e) => e.stepId === failingStepId);
    if (idx > 0) startIdx = idx - 1;
    else if (idx === 0) return null; // failed at the very first step
    // idx === -1 (failing step not in trace) → keep startIdx = end
  }

  for (let i = startIdx; i >= 0; i--) {
    const entry = trace[i];
    if (entry.status !== 'completed') continue;
    if (entry.output === undefined || entry.output === null) continue;
    return {
      stepId: entry.stepId,
      stepName: entry.label,
      output: entry.output,
    };
  }
  return null;
}

/** Count skipped steps and split by whether the workflow author opted
 * in (`expectedSkip: true`) or the skip happened by accident
 * (`errorStrategy: 'skip'` absorbing a real error). */
export function tallySkips(trace: ExecutionTraceEntry[]): SkipBreakdown {
  const expected: ExecutionTraceEntry[] = [];
  const unexpected: ExecutionTraceEntry[] = [];
  for (const e of trace) {
    if (e.status !== 'skipped') continue;
    if (e.expectedSkip) expected.push(e);
    else unexpected.push(e);
  }
  return { total: expected.length + unexpected.length, expected, unexpected };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** Pick the headline step + reason for a failed execution.
 *
 * Priority:
 *  1. A trace entry with `status === 'failed'` — the executor-threw path.
 *  2. A trace entry whose retries[] exhausted — the retry-exhaustion path
 *     (where the workflow then routed to a terminalStatus-authored
 *     send_notification, leaving the headline step's status === 'completed').
 *  3. No trace step matches → engine-level failure (budget, deadlock,
 *     abort) — use `execution.errorMessage` as the reason and no
 *     headline step.
 */
function buildFailureAnalysis(
  execution: SynopsisExecution,
  trace: ExecutionTraceEntry[],
  skips: SkipBreakdown
): Extract<SynopsisAnalysis, { kind: 'failure' }> {
  const failedEntry = findFailedStep(trace);
  if (failedEntry) {
    return {
      kind: 'failure',
      reason: nonEmpty(failedEntry.error) ?? nonEmpty(execution.errorMessage) ?? 'Step failed',
      headlineStep: failedEntry,
      retries: failedEntry.retries ?? [],
      predecessor: findPredecessorContext(trace, failedEntry.stepId),
      skips,
      terminalAuthor: null,
    };
  }

  const exhausted = findExhaustedRetry(trace);
  if (exhausted) {
    // The terminalStatus author is the step the engine routed to after
    // exhaustion — usually a send_notification with terminalStatus:
    // 'failed'. We surface it so the synopsis can read
    // "Validation exhausted at X → workflow finalised via Y".
    const terminalAuthor = findStepById(trace, exhausted.targetStepId);
    return {
      kind: 'failure',
      reason: nonEmpty(exhausted.reason) ?? nonEmpty(execution.errorMessage) ?? 'Retry exhausted',
      headlineStep: exhausted.step,
      retries: exhausted.step.retries ?? [],
      predecessor: findPredecessorContext(trace, exhausted.step.stepId),
      skips,
      terminalAuthor,
    };
  }

  // Engine-level failure. No trace step to spotlight. Use the engine's
  // stored reason; fall back to currentStep for "where" context.
  return {
    kind: 'failure',
    reason: nonEmpty(execution.errorMessage) ?? 'Workflow failed',
    headlineStep: findStepById(trace, execution.currentStep),
    retries: [],
    predecessor: findPredecessorContext(trace, execution.currentStep),
    skips,
    terminalAuthor: null,
  };
}

function findStepById(
  trace: ExecutionTraceEntry[],
  stepId: string | null
): ExecutionTraceEntry | null {
  if (!stepId) return null;
  return trace.find((e) => e.stepId === stepId) ?? null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
