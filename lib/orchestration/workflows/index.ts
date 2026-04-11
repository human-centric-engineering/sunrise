/**
 * Public surface of `lib/orchestration/workflows/`.
 *
 * Phase 3.2 ships only the structural DAG validator. The real
 * executor, step runners, and approval-resume helpers land with
 * Session 5.2 and will be re-exported from this barrel at that time.
 */

export { validateWorkflow } from './validator';
export type { WorkflowValidationResult, WorkflowValidationError } from './validator';
