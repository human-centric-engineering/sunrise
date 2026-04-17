/**
 * Event factory helpers.
 *
 * Executors and the engine construct `ExecutionEvent` values here
 * rather than by object literal so that the shapes stay in sync with
 * the `ExecutionEvent` union in `types/orchestration.ts`.
 */

import type { ExecutionEvent, WorkflowStepType } from '@/types/orchestration';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';

export function workflowStarted(executionId: string, workflowId: string): ExecutionEvent {
  return { type: 'workflow_started', executionId, workflowId };
}

export function stepStarted(
  stepId: string,
  stepType: WorkflowStepType,
  label: string
): ExecutionEvent {
  return { type: 'step_started', stepId, stepType, label };
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
  void dispatchWebhookEvent('approval_required', { stepId, payload });
  return { type: 'approval_required', stepId, payload };
}

export function budgetWarning(usedUsd: number, limitUsd: number): ExecutionEvent {
  return { type: 'budget_warning', usedUsd, limitUsd };
}

export function workflowCompleted(
  output: unknown,
  totalTokensUsed: number,
  totalCostUsd: number
): ExecutionEvent {
  return { type: 'workflow_completed', output, totalTokensUsed, totalCostUsd };
}

export function workflowFailed(error: string, failedStepId?: string): ExecutionEvent {
  void dispatchWebhookEvent('workflow_failed', { error, failedStepId });
  return { type: 'workflow_failed', error, failedStepId };
}
