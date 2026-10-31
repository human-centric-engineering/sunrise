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
 * Step ids and counts only. Nothing here is step output, so erasure has
 * nothing to scrub; the bounded-retry failure reason is rebuilt from the trace
 * (`retryContextFromTrace`), which erasure does scrub.
 */

import { z } from 'zod';

import type { ExecutionTraceEntry } from '@/types/orchestration';

export const walkPositionSchema = z.object({
  /** Shape version, so a later change can tell an old position from a new one. */
  v: z.literal(1),
  /** The steps of the iteration that was running: one, or a parallel batch's branches. */
  inFlight: z.array(z.string()),
  /** In-flight steps that finished, each with the next steps it chose. */
  done: z.record(z.string(), z.array(z.string())),
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
    .object({ entry: z.number().int().nonnegative(), retry: z.number().int().nonnegative() })
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
  const entry = trace[at.entry];
  const retry = entry?.retries?.[at.retry];
  if (!entry || !retry) return undefined;
  return {
    fromStep: entry.stepId,
    attempt: retry.attempt,
    maxRetries: retry.maxRetries,
    failureReason: retry.reason,
  };
}
