/**
 * Pull the human-approval prompt out of an execution trace.
 *
 * The `human_approval` step throws `PausedForApproval(stepId, { prompt, … })`
 * which the engine catches and persists onto the awaiting step's
 * `output.prompt`. This helper finds the awaiting step (if any) and
 * returns its prompt as a string, or `null` when the run is not paused
 * or the persisted output isn't shaped as expected.
 *
 * Used by both the execution-detail view and the inline progress
 * component embedded in the audit dialog — keep them in lockstep so
 * the admin sees the same approval text wherever they encounter it.
 */
import { z } from 'zod';

import type { ExecutionTraceEntry } from '@/types/orchestration';

const approvalOutputSchema = z.object({ prompt: z.string() });

export function getApprovalPrompt(trace: ExecutionTraceEntry[]): string | null {
  const entry = trace.find((e) => e.status === 'awaiting_approval');
  if (!entry?.output) return null;
  const parsed = approvalOutputSchema.safeParse(entry.output);
  return parsed.success ? parsed.data.prompt : null;
}
