/**
 * Approver scoping — checks whether a user is listed as a delegated
 * approver in an execution's trace.
 *
 * Used by admin approve/reject routes to allow non-owners to act on
 * executions they are designated to review.
 */

import { z } from 'zod';
import { executionTraceSchema } from '@/lib/validations/orchestration';

/**
 * Schema for the output of an awaiting_approval trace entry that may
 * contain approverUserIds.
 */
const approvalOutputSchema = z
  .object({
    approverUserIds: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Check whether `userId` appears in the `approverUserIds` list from the
 * trace's `awaiting_approval` entry output.
 *
 * Returns `false` if the trace is malformed, has no awaiting entry, or
 * the output doesn't contain `approverUserIds`.
 */
export function isApproverInTrace(executionTrace: unknown, userId: string): boolean {
  const trace = executionTraceSchema.safeParse(executionTrace);
  if (!trace.success) return false;

  const awaitingEntry = trace.data.find((e) => e.status === 'awaiting_approval');
  if (!awaitingEntry) return false;

  const output = approvalOutputSchema.safeParse(awaitingEntry.output);
  if (!output.success) return false;

  return output.data.approverUserIds?.includes(userId) ?? false;
}
