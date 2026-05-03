/**
 * Evaluations module barrel.
 *
 * Re-exports the public surface of the evaluations handler layer for
 * consumption by the admin API routes and by tests.
 */

export {
  completeEvaluationSession,
  rescoreEvaluationSession,
} from '@/lib/orchestration/evaluations/complete-session';
export type {
  CompleteEvaluationParams,
  CompleteEvaluationResult,
  EvaluationMetricSummary,
  RescoreEvaluationParams,
  RescoreEvaluationResult,
} from '@/lib/orchestration/evaluations/types';
