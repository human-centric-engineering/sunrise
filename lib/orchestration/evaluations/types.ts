/**
 * Shared types for the evaluations handler module.
 *
 * Platform-agnostic. No Next.js imports. Consumed by the admin
 * `/evaluations/[id]/complete` route and by unit tests.
 */

export interface CompleteEvaluationParams {
  sessionId: string;
  userId: string;
}

export interface CompleteEvaluationResult {
  sessionId: string;
  status: 'completed';
  summary: string;
  improvementSuggestions: string[];
  tokenUsage: { input: number; output: number };
  costUsd: number;
}
