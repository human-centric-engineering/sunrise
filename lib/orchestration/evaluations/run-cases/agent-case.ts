/**
 * Agent subject case execution.
 *
 * Thin wrapper around `drainStreamChat` for the subject side of an
 * evaluation case. The judge side uses the same helper from the
 * `judge_agent` grader.
 *
 * Deliberately does NOT set `contextType: 'evaluation'` — that flag
 * routes streamChat to write `AiEvaluationLog` rows for manual
 * sessions. Batch runs write to `AiEvaluationCaseResult` instead, so
 * we let streamChat persist the standard AiMessage rows (as a normal
 * conversation row) without mirroring them into evaluation logs.
 */

import {
  drainStreamChat,
  type DrainResult,
} from '@/lib/orchestration/evaluations/drain-stream-chat';

export interface AgentCaseInput {
  agentSlug: string;
  userId: string;
  /** The case `input` — string for agent subjects. */
  message: string;
  /** Per-case cancellation. */
  signal?: AbortSignal;
  /**
   * Set by the batch worker so the underlying `streamChat` call tags
   * its `AiCostLog` rows with `{ evaluationRunId, role: 'subject' }`.
   * Drives the empirical cost-estimator's per-role spend lookup.
   */
  evaluationRunId?: string;
}

export type AgentCaseResult = DrainResult;

export async function runAgentCase(input: AgentCaseInput): Promise<AgentCaseResult> {
  return drainStreamChat({
    agentSlug: input.agentSlug,
    userId: input.userId,
    message: input.message,
    includeTrace: true,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.evaluationRunId
      ? { costLogMetadata: { evaluationRunId: input.evaluationRunId, role: 'subject' } }
      : {}),
  });
}
