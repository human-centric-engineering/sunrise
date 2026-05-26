/**
 * Workflow subject case execution.
 *
 * Loads the workflow's published version, runs it through
 * `OrchestrationEngine.execute()` with the case input as workflow
 * variables, and resolves `subjectOutputSelector` against the resulting
 * `AiWorkflowExecution` row using the same helper trace-to-dataset
 * capture uses. The engine row's `workflowExecutionId` is the join key
 * for `AiCostLog` rollup; per-row `metadata.evaluationRunId` is set by
 * the engine's `costLogMetadata` plumbing.
 *
 * Phase 1 shipped this file as a stub returning
 * `workflow_subject_not_supported_in_phase_1`. Phase 3 wires it through.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  resolveSelectorOutput,
  type WorkflowSubjectOutputSelector,
} from '@/lib/orchestration/evaluations/datasets/capture';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import type { Citation, ToolCallTrace, WorkflowDefinition } from '@/types/orchestration';
import { isRecord } from '@/lib/utils';

export interface WorkflowCaseInput {
  workflowId: string;
  userId: string;
  /** Workflow input variables — an object keyed by variable name. */
  input: Record<string, unknown>;
  subjectOutputSelector: unknown;
  signal?: AbortSignal;
  /**
   * Set by the worker so per-step `AiCostLog` rows are tagged
   * `{ evaluationRunId, role: 'subject' }`. Drives the empirical
   * cost-estimator's per-role spend lookup.
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

const log = logger.child({ component: 'workflow-case' });

function parseSelector(raw: unknown): WorkflowSubjectOutputSelector {
  // Default: last_step. Matches what the API route stores when the caller
  // omits the selector — keeps the worker's behaviour deterministic when
  // the column carries a partial / legacy shape.
  if (!isRecord(raw)) return { kind: 'last_step' };
  const kind = raw.kind;
  if (kind === 'final_report' || kind === 'last_step' || kind === 'step_id') {
    const stepId = typeof raw.stepId === 'string' ? raw.stepId : undefined;
    return stepId ? { kind, stepId } : { kind };
  }
  return { kind: 'last_step' };
}

function emptyResult(): WorkflowCaseResult {
  return {
    assistantText: '',
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 0, output: 0 },
    costUsd: 0,
    latencyMs: 0,
  };
}

function errorResult(code: string, message: string): WorkflowCaseResult {
  return { ...emptyResult(), errorCode: code, errorMessage: message };
}

export async function runWorkflowCase(input: WorkflowCaseInput): Promise<WorkflowCaseResult> {
  if (!input.workflowId) {
    return errorResult('workflow_id_missing', 'Run row has no workflowId; cannot dispatch.');
  }

  const workflowRow = await prisma.aiWorkflow.findUnique({
    where: { id: input.workflowId },
    select: {
      id: true,
      isActive: true,
      publishedVersion: { select: { id: true, snapshot: true } },
    },
  });
  if (!workflowRow) {
    return errorResult('workflow_not_found', `Workflow ${input.workflowId} not found.`);
  }
  if (!workflowRow.isActive) {
    return errorResult(
      'workflow_inactive',
      `Workflow ${input.workflowId} is inactive — re-enable it to run evaluations.`
    );
  }
  if (!workflowRow.publishedVersion) {
    return errorResult(
      'workflow_not_published',
      `Workflow ${input.workflowId} has no published version. Publish a version before running an evaluation.`
    );
  }

  const parsed = workflowDefinitionSchema.safeParse(workflowRow.publishedVersion.snapshot);
  if (!parsed.success) {
    log.error('workflow-case: published definition failed schema validation', {
      workflowId: workflowRow.id,
      versionId: workflowRow.publishedVersion.id,
      issues: parsed.error.issues.length,
    });
    return errorResult(
      'workflow_malformed',
      `Workflow ${input.workflowId} has a malformed published definition.`
    );
  }
  const definition = parsed.data as WorkflowDefinition;
  const selector = parseSelector(input.subjectOutputSelector);
  const started = Date.now();

  const engine = new OrchestrationEngine();
  let executionId: string | undefined;
  let totalCostUsd = 0;
  let totalTokensUsed = 0;
  let failure: { error: string; failedStepId?: string } | undefined;
  let approvalRequiredStep: string | undefined;

  try {
    for await (const event of engine.execute(
      {
        id: workflowRow.id,
        definition,
        versionId: workflowRow.publishedVersion.id,
      },
      input.input,
      {
        userId: input.userId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.evaluationRunId
          ? {
              costLogMetadata: {
                evaluationRunId: input.evaluationRunId,
                role: 'subject',
              },
            }
          : {}),
      }
    )) {
      switch (event.type) {
        case 'workflow_started':
          executionId = event.executionId;
          break;
        case 'workflow_completed':
          totalCostUsd = event.totalCostUsd;
          totalTokensUsed = event.totalTokensUsed;
          break;
        case 'workflow_failed':
          failure = {
            error: event.error,
            ...(event.failedStepId ? { failedStepId: event.failedStepId } : {}),
          };
          break;
        case 'approval_required':
          approvalRequiredStep = event.stepId;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    log.error('workflow-case: engine threw during execute', {
      workflowId: workflowRow.id,
      executionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...emptyResult(),
      latencyMs: Date.now() - started,
      errorCode: 'workflow_dispatch_failed',
      errorMessage: err instanceof Error ? err.message : 'Workflow execution failed',
    };
  }

  const latencyMs = Date.now() - started;

  if (approvalRequiredStep) {
    // Evaluation runs can't pause for a human — the worker drains
    // hundreds of cases unattended. Surface a per-case error so the
    // operator sees which workflow needs the human-approval step
    // bypassed or replaced.
    return {
      ...emptyResult(),
      latencyMs,
      errorCode: 'workflow_paused_for_approval',
      errorMessage: `Workflow paused at step "${approvalRequiredStep}" for human approval — evaluation runs cannot resume from an approval gate.`,
    };
  }

  if (failure) {
    return {
      ...emptyResult(),
      latencyMs,
      costUsd: totalCostUsd,
      tokenUsage: { input: totalTokensUsed, output: 0 },
      errorCode: 'workflow_failed',
      errorMessage: failure.failedStepId
        ? `Workflow failed at step ${failure.failedStepId}: ${failure.error}`
        : failure.error,
    };
  }

  if (!executionId) {
    return {
      ...emptyResult(),
      latencyMs,
      errorCode: 'workflow_no_execution_id',
      errorMessage: 'Engine drained without yielding workflow_started — internal error.',
    };
  }

  // Re-read the finalised row so the resolver can run against the same
  // `executionTrace` + `outputData` snapshot the engine just persisted.
  // The engine writes `outputData` at finalize-time; reading it back via
  // a fresh query avoids reproducing the engine's terminal-write rules.
  const finalRow = await prisma.aiWorkflowExecution.findUnique({
    where: { id: executionId },
    select: { outputData: true, executionTrace: true },
  });
  if (!finalRow) {
    return {
      ...emptyResult(),
      latencyMs,
      costUsd: totalCostUsd,
      tokenUsage: { input: totalTokensUsed, output: 0 },
      errorCode: 'workflow_row_missing',
      errorMessage: `AiWorkflowExecution ${executionId} disappeared between drain and selector read — internal error.`,
    };
  }

  const resolved = resolveSelectorOutput(finalRow, selector);
  if (resolved === null) {
    return {
      ...emptyResult(),
      latencyMs,
      costUsd: totalCostUsd,
      tokenUsage: { input: totalTokensUsed, output: 0 },
      errorCode: 'selector_unresolved',
      errorMessage: `Selector ${selector.kind}${selector.stepId ? `:${selector.stepId}` : ''} did not resolve to any output on execution ${executionId}.`,
    };
  }

  return {
    assistantText: resolved,
    citations: [],
    toolCalls: [],
    tokenUsage: { input: totalTokensUsed, output: 0 },
    costUsd: totalCostUsd,
    latencyMs,
  };
}
