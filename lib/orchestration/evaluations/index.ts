/**
 * Evaluations module barrel.
 *
 * Re-exports the public surface of the evaluations handler layer for
 * consumption by the admin API routes and by tests.
 */

export { completeEvaluationSession } from '@/lib/orchestration/evaluations/complete-session';
export type { CompleteEvaluationParams, CompleteEvaluationResult } from './types';
