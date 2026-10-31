/**
 * Where a workflow's DAG walk had got to, saved on `AiWorkflowExecution.walkState`
 * so a crash-resume continues exactly where the run stopped (t-966).
 *
 * The engine saves a position at the start of every walk iteration, before the
 * iteration's steps run, and each checkpoint adds the step it records to
 * `done` with the next steps that step chose. So after a crash the saved
 * position says which steps were in flight, and `done` says which of them
 * finished — written in the same update as their trace entries, so the two
 * never disagree. The resume re-runs the rest and replays the walk's own
 * "what runs next" logic for the finished ones.
 *
 * Rebuilding the walk from `currentStep` instead was tried and failed review:
 * the cursor is written when a step starts and races across a parallel
 * batch, so every rebuild missed a case — loops, a branch's successors, a
 * route's untaken edge, a bounded retry's count.
 *
 * Step ids and counts only, plus a `failWorkflow` step's authored message.
 * Nothing here is step output, so erasure has nothing to scrub; the
 * bounded-retry failure reason is rebuilt from the trace
 * (`retryContextFromTrace`), which erasure does scrub.
 */

import { z } from 'zod';

import type { ExecutionTraceEntry } from '@/types/orchestration';

export const walkPositionSchema = z.object({
  /** Shape version, so a later change can tell an old position from a new one. */
  v: z.literal(1),
  /** The steps of the iteration that was running: one, or a parallel batch's branches. */
  inFlight: z.array(z.string()),
  /**
   * Whether that iteration ran on the parallel-batch path, which hands on
   * differently (it ignores `terminal` and bounded-retry edges). Usually
   * `inFlight.length > 1`, but a resume re-runs a batch's lone unfinished
   * branch as a batch too.
   */
  batch: z.boolean(),
  /** In-flight steps that finished, each with the next steps it chose. */
  done: z.record(z.string(), z.array(z.string())),
  /**
   * Set when a step ended the run — its checkpoint is the last write before
   * the run is finalised — so a crash-resume finalises it the same way
   * instead of re-running the step (and paying for it twice). `kind` says how;
   * the failure text is read back from the trace, except a `failWorkflow`
   * message, which is the step's own authored text and is kept here.
   */
  ended: z
    .object({
      stepId: z.string(),
      kind: z.enum(['terminal', 'failed', 'failWorkflow', 'budget']),
      message: z.string().optional(),
    })
    .optional(),
  /** Steps waiting on a predecessor. */
  pending: z.array(z.string()),
  /** Steps the walk has visited, the in-flight ones included. */
  visited: z.array(z.string()),
  /** Bounded-retry edge counts, keyed `source→target`. */
  retryCounts: z.record(z.string(), z.number().int().nonnegative()),
  /** Steps run so far, against `MAX_STEPS_PER_RUN`. */
  stepCount: z.number().int().nonnegative(),
  /** Whether the 80% budget warning has been sent. */
  budgetWarned: z.boolean(),
  /** Where the retry that set `__retryContext` sits: its trace entry, and its index in that entry's `retries`. */
  retryContextAt: z
    .object({
      entry: z.number().int().nonnegative(),
      retry: z.number().int().nonnegative(),
      /** The step whose entry it is, checked on read: a resume drops trace entries it cannot parse, which shifts the index. */
      step: z.string(),
    })
    .optional(),
});

export type WalkPosition = z.infer<typeof walkPositionSchema>;

/** Parse a stored position, or `null` for none or one this engine cannot read. */
export function parseWalkPosition(value: unknown): WalkPosition | null {
  if (value === null || value === undefined) return null;
  const parsed = walkPositionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Rebuild `ctx.variables.__retryContext` from the trace entry a bounded retry
 * attached itself to. The live value's `failureReason` may be an object; the
 * trace holds it as the string the retry event carried, which is what a
 * resumed step's prompt then sees.
 */
export function retryContextFromTrace(
  trace: readonly ExecutionTraceEntry[],
  at: WalkPosition['retryContextAt']
): Record<string, unknown> | undefined {
  if (at === undefined) return undefined;
  // The index is where the entry was when the retry attached. If a corrupt
  // earlier entry was dropped on resume it has moved: find the step's latest
  // entry carrying a retry instead.
  let entry: ExecutionTraceEntry | undefined;
  let retry: NonNullable<ExecutionTraceEntry['retries']>[number] | undefined;
  if (trace[at.entry]?.stepId === at.step) {
    entry = trace[at.entry];
    retry = entry.retries?.[at.retry];
  } else {
    for (let i = trace.length - 1; i >= 0 && !retry; i--) {
      if (trace[i].stepId !== at.step) continue;
      entry = trace[i];
      retry = entry.retries?.findLast((r) => r.exhausted !== true);
    }
  }
  if (!entry || !retry) return undefined;
  return {
    fromStep: entry.stepId,
    attempt: retry.attempt,
    maxRetries: retry.maxRetries,
    failureReason: retry.reason,
  };
}
