/**
 * Shared types for the evaluations handler module.
 *
 * Platform-agnostic. No Next.js imports. Consumed by the admin
 * `/evaluations/[id]/complete` and `/rescore` routes, and by unit tests.
 */

export interface CompleteEvaluationParams {
  sessionId: string;
  userId: string;
}

/** Aggregate metric summary persisted on `AiEvaluationSession.metricSummary`. */
export interface EvaluationMetricSummary {
  /** Mean across logs that produced a non-null faithfulness score. Null when no log was scoreable. */
  avgFaithfulness: number | null;
  /** Mean across all scored logs. */
  avgGroundedness: number | null;
  /** Mean across all scored logs. */
  avgRelevance: number | null;
  /** Number of `ai_response` logs successfully scored in this run. */
  scoredLogCount: number;
  /** Provider slug used by the judge model for this run. */
  judgeProvider: string;
  /** Model id used by the judge for this run. */
  judgeModel: string;
  /** ISO timestamp of the latest scoring pass (overwritten on rescore). */
  scoredAt: string;
  /** Cumulative USD spend on scoring across initial completion + any rescores. */
  totalScoringCostUsd: number;
}

export interface CompleteEvaluationResult {
  sessionId: string;
  status: 'completed';
  summary: string;
  improvementSuggestions: string[];
  tokenUsage: { input: number; output: number };
  /** Cost of the summary call only. Per-metric scoring cost lives on metricSummary.totalScoringCostUsd. */
  costUsd: number;
  /** Null when scoring failed wholesale or the session had no `ai_response` logs. */
  metricSummary: EvaluationMetricSummary | null;
}

export interface RescoreEvaluationParams {
  sessionId: string;
  userId: string;
}

export interface RescoreEvaluationResult {
  sessionId: string;
  metricSummary: EvaluationMetricSummary;
}
