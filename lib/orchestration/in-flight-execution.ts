/**
 * Cross-page handoff for "an audit is running in the background".
 *
 * The Audit Models dialog persists the execution id + a small label
 * to localStorage when the operator chooses "Run in background". The
 * peek banner mounted in the orchestration sub-layout reads from the
 * same key on every page within `/admin/orchestration/*` and renders
 * a compact pill with a click-through to the canonical detail page.
 *
 * Versioned key (`.v1`) so a future change to the stored shape (e.g.
 * tracking multiple in-flight executions as an array) can safely
 * invalidate any stale entries written by older clients without
 * silently misinterpreting them.
 */

export const IN_FLIGHT_EXECUTION_STORAGE_KEY = 'sunrise.orchestration.in-flight-execution.v1';

export interface InFlightExecutionRef {
  executionId: string;
  /** Short, operator-facing label — e.g. the originating workflow's name. */
  label: string;
  /** ISO timestamp the run was triggered, used to bound staleness. */
  startedAt: string;
}
