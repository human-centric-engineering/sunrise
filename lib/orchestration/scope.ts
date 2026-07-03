/**
 * Persisted scope carrier helpers
 *
 * `CapabilityContext.scope` (introduced in 0.5.0) can be persisted on several
 * rows — `AiWorkflowExecution.scope`, `AiWorkflowSchedule.scope`,
 * `AiWorkflowTrigger.scope`, `McpApiKey.scope`. Those JSON columns are
 * admin-written and MUST NOT be trusted raw when read back: a malformed value
 * (hand-edited row, older shape) must never wedge a run or lock a caller out.
 *
 * This helper centralises the validate-on-read contract for the workflow-side
 * columns: parse against `workflowScopeSchema`, and on failure drop to
 * unscoped (return `undefined`) with a warning rather than throwing. Callers
 * spread the result conditionally: `...(scope ? { scope } : {})`.
 */

import { logger } from '@/lib/logging';
import { workflowScopeSchema } from '@/lib/validations/orchestration';

/**
 * Validate a persisted scope JSON column before trusting it.
 *
 * @param value   The raw column value (`null`/`undefined` when unset).
 * @param context Structured fields identifying the row, logged if the value is
 *   malformed (e.g. `{ scheduleId }`, `{ triggerId }`, `{ executionId }`).
 * @returns The validated `Record<string, string>`, or `undefined` when the
 *   column is unset or malformed (drop-to-unscoped — never throws).
 */
export function resolvePersistedScope(
  value: unknown,
  context: Record<string, unknown>
): Record<string, string> | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = workflowScopeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger.warn('Dropped malformed persisted workflow scope', {
    ...context,
    issues: parsed.error.issues.length,
  });
  return undefined;
}
