/**
 * Workflow subject case execution.
 *
 * Phase 1 ships the data model + worker dispatch branch so the schema
 * is forward-compatible with Phase 3's UI. The actual workflow run
 * dispatch — including `subjectOutputSelector` resolution and step-
 * level cost rollup — is wired in Phase 3.
 *
 * Calls into this from the run-worker throw, marking the case
 * `errorCode: 'workflow_subject_not_supported_in_phase_1'`. The
 * pre-flight check in the run-creation API blocks `subjectKind:
 * 'workflow'` from reaching the worker until Phase 3 lands.
 */

import type { Citation, ToolCallTrace } from '@/types/orchestration';

export interface WorkflowCaseInput {
  workflowId: string;
  userId: string;
  /** Workflow input variables — an object keyed by variable name. */
  input: Record<string, unknown>;
  subjectOutputSelector: unknown;
  signal?: AbortSignal;
  /**
   * Forward-compat: Phase 3 wires this through to the workflow executor
   * so per-step `AiCostLog` rows are tagged `{ evaluationRunId,
   * role: 'subject' }`. Today's stub ignores it.
   */
  evaluationRunId?: string;
}

export interface WorkflowCaseResult {
  assistantText: string;
  citations: Citation[];
  toolCalls: ToolCallTrace[];
  tokenUsage: { input: number; output: number };
  costUsd: number;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
}

export async function runWorkflowCase(_input: WorkflowCaseInput): Promise<WorkflowCaseResult> {
  // Async signature kept so the worker's per-case dispatch shape doesn't
  // change between Phase 1 and Phase 3.
  await Promise.resolve();
  return {
    assistantText: '',
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 0, output: 0 },
    costUsd: 0,
    latencyMs: 0,
    errorCode: 'workflow_subject_not_supported_in_phase_1',
    errorMessage:
      'Workflow-as-subject runs land in Phase 3. The schema is ready, but the dispatcher is not. Use an agent subject for now.',
  };
}
