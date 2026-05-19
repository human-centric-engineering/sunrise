/**
 * Overlay step descriptions onto historical trace entries.
 *
 * Trace entries are pinned-in-time records — once written, their fields
 * are not rewritten. When the `WorkflowStep.description` field was added
 * (May 2026) every existing execution's trace entries had no
 * `description`, so the admin viewer's expanded body showed nothing.
 *
 * This helper fills the gap: when a trace entry lacks a `description`,
 * look up its `stepId` in the workflow snapshot the execution ran
 * against and copy the step's description over.
 *
 * Rules:
 *   - Trace-entry value wins. If the entry already carries a description
 *     (newer executions do), we keep it as-is — that's the audit-honest
 *     pinned-in-time value.
 *   - Snapshot is treated as `unknown` and shape-checked defensively.
 *     A malformed snapshot returns the trace unchanged rather than
 *     throwing — better to lose the overlay than to fail the page.
 *   - Empty descriptions in the snapshot are skipped so we don't
 *     replace "no description" with another "no description".
 *
 * Pure function — no DB, no I/O. The route loads the snapshot once and
 * passes it in.
 */

import type { ExecutionTraceEntry } from '@/types/orchestration';

export interface OverlayInput {
  trace: readonly ExecutionTraceEntry[];
  /**
   * The workflow snapshot from `AiWorkflowVersion.snapshot`. Typed as
   * `unknown` because Prisma returns the JSON column as `JsonValue`;
   * we shape-check inside the helper rather than coercing at the call
   * site.
   */
  snapshot: unknown;
}

export function overlayStepDescriptions(input: OverlayInput): ExecutionTraceEntry[] {
  const { trace, snapshot } = input;
  const traceArray = [...trace];
  if (!snapshot || typeof snapshot !== 'object') return traceArray;
  const steps = (snapshot as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return traceArray;

  // Build the lookup once. Skips entries that don't carry both a string
  // `id` and a non-empty string `description` so the map never holds a
  // value we'd then have to filter out at lookup time.
  const descriptionByStepId = new Map<string, string>();
  for (const step of steps) {
    if (
      step &&
      typeof step === 'object' &&
      typeof (step as { id?: unknown }).id === 'string' &&
      typeof (step as { description?: unknown }).description === 'string' &&
      (step as { description: string }).description.length > 0
    ) {
      descriptionByStepId.set(
        (step as { id: string }).id,
        (step as { description: string }).description
      );
    }
  }
  if (descriptionByStepId.size === 0) return traceArray;

  return traceArray.map((entry) => {
    // Trace-entry value wins — preserves the audit-honest snapshot of
    // what was true at execution time. Only fill when absent.
    if (entry.description) return entry;
    const overlay = descriptionByStepId.get(entry.stepId);
    return overlay ? { ...entry, description: overlay } : entry;
  });
}
