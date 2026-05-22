/**
 * Event factory helpers.
 *
 * Executors and the engine construct `ExecutionEvent` values here
 * rather than by object literal so that the shapes stay in sync with
 * the `ExecutionEvent` union in `types/orchestration.ts`.
 */

import type { ExecutionEvent, WorkflowStepType } from '@/types/orchestration';
import { logger } from '@/lib/logging';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';

export function workflowStarted(executionId: string, workflowId: string): ExecutionEvent {
  return { type: 'workflow_started', executionId, workflowId };
}

export function stepStarted(
  stepId: string,
  stepType: WorkflowStepType,
  label: string,
  description?: string
): ExecutionEvent {
  return {
    type: 'step_started',
    stepId,
    stepType,
    label,
    ...(description ? { description } : {}),
  };
}

export function stepCompleted(
  stepId: string,
  output: unknown,
  tokensUsed: number,
  costUsd: number,
  durationMs: number
): ExecutionEvent {
  return { type: 'step_completed', stepId, output, tokensUsed, costUsd, durationMs };
}

export function stepFailed(stepId: string, error: string, willRetry: boolean): ExecutionEvent {
  return { type: 'step_failed', stepId, error, willRetry };
}

export function approvalRequired(stepId: string, payload: unknown): ExecutionEvent {
  // Webhook dispatch for approval_required is handled by pauseForApproval()
  // in the engine, which has richer context (workflowId, userId, prompt).
  return { type: 'approval_required', stepId, payload };
}

export function stepRetry(
  fromStepId: string,
  targetStepId: string,
  attempt: number,
  maxRetries: number,
  reason: string,
  exhausted = false
): ExecutionEvent {
  return {
    type: 'step_retry',
    fromStepId,
    targetStepId,
    attempt,
    maxRetries,
    reason,
    ...(exhausted ? { exhausted: true } : {}),
  };
}

export function budgetWarning(usedUsd: number, limitUsd: number): ExecutionEvent {
  return { type: 'budget_warning', usedUsd, limitUsd };
}

/**
 * Fires when the per-execution cost cap is breached. Emitted by the
 * engine immediately before `workflow_failed` at all four cap-check
 * sites — sequential main loop, single-step path, parallel batch, and
 * executor-thrown `BudgetExceeded` — so subscribers can branch on the
 * more-specific event (runaway-loop guard from improvement #39) without
 * string-matching on `workflow_failed.error`. The standard
 * `workflow_failed` event still follows and remains the terminal-event
 * contract for trace consumers.
 *
 * Also dispatches the `workflow_budget_exceeded` webhook (fire-and-forget;
 * a webhook failure must never block the terminal event sequence). The
 * generic `workflow_failed` webhook still fires from `workflowFailed()`
 * below — subscribers wanting only one notification should listen to the
 * specific event and ignore the generic one.
 */
export function workflowBudgetExceeded(
  usedUsd: number,
  limitUsd: number,
  failedStepId: string,
  executionId?: string
): ExecutionEvent {
  dispatchWebhookEvent('workflow_budget_exceeded', {
    usedUsd,
    limitUsd,
    failedStepId,
    ...(executionId ? { executionId } : {}),
  }).catch((err) => {
    logger.warn('Webhook dispatch failed for workflow_budget_exceeded', {
      failedStepId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return { type: 'workflow_budget_exceeded', usedUsd, limitUsd, failedStepId };
}

export function workflowCompleted(
  output: unknown,
  totalTokensUsed: number,
  totalCostUsd: number
): ExecutionEvent {
  return { type: 'workflow_completed', output, totalTokensUsed, totalCostUsd };
}

export function workflowFailed(error: string, failedStepId?: string): ExecutionEvent {
  dispatchWebhookEvent('workflow_failed', { error, failedStepId }).catch((err) => {
    logger.warn('Webhook dispatch failed for workflow_failed', {
      failedStepId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return { type: 'workflow_failed', error, failedStepId };
}
