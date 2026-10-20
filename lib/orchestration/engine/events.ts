/**
 * Event factory helpers.
 *
 * Executors and the engine construct `ExecutionEvent` values here
 * rather than by object literal so that the shapes stay in sync with
 * the `ExecutionEvent` union in `types/orchestration.ts`.
 */

import type { ExecutionEvent, WorkflowStepType } from '@/types/orchestration';
import { logger } from '@/lib/logging';
import { keepRunningAfterResponse } from '@/lib/api/after-response';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import {
  resolveUserDisplayName,
  resolveWorkflowDisplay,
} from '@/lib/orchestration/webhooks/payload-context';

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

/** The run a `workflow_budget_exceeded` event is about. */
export interface BudgetExceededRun {
  executionId?: string;
  workflowId?: string;
  /** The run's owner; `null` for a system-owned run. */
  userId: string | null;
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
 *
 * `run.userId` is the run's owner, `null` for a system-owned run, as on the
 * other run events. It names them on the payload itself, so erasure and subject access
 * still find the delivery once the run is gone (t-792). It is required, `null`
 * included, so a new call site cannot leave it out by accident.
 */
export function workflowBudgetExceeded(
  usedUsd: number,
  limitUsd: number,
  failedStepId: string,
  run: BudgetExceededRun
): ExecutionEvent {
  const { executionId, workflowId, userId } = run;
  dispatchWebhookEvent('workflow_budget_exceeded', {
    usedUsd,
    limitUsd,
    failedStepId,
    ...(executionId ? { executionId } : {}),
    ...(workflowId ? { workflowId } : {}),
    userId,
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

/**
 * Optional execution-level context piped into the `workflow_failed`
 * webhook payload. Every field is best-effort — receivers should treat
 * missing entries as "not in scope at this call site" rather than as
 * the value being null.
 */
export interface WorkflowFailedWebhookMeta {
  executionId?: string;
  workflowId?: string;
  /** User who initiated the execution. */
  userId?: string | null;
  /** Engine running totals at the point of failure. */
  totalCostUsd?: number;
  totalTokensUsed?: number;
}

export function workflowFailed(
  error: string,
  failedStepId?: string,
  meta?: WorkflowFailedWebhookMeta
): ExecutionEvent {
  // Run name lookups + dispatch inside an async IIFE so the synchronous
  // factory can still return the ExecutionEvent immediately. Errors are
  // swallowed with a logger.warn — a webhook failure must never block
  // the engine's terminal event sequence. Kept alive past the response
  // (t-903): the run ends here, so the drain's hold ends next, and the name
  // lookups would otherwise run with nothing holding the invocation open.
  keepRunningAfterResponse(
    (async () => {
      try {
        const [workflow, actorUserName] = await Promise.all([
          resolveWorkflowDisplay(meta?.workflowId),
          resolveUserDisplayName(meta?.userId),
        ]);
        await dispatchWebhookEvent('workflow_failed', {
          error,
          failedStepId,
          executionId: meta?.executionId,
          workflowId: meta?.workflowId,
          workflowSlug: workflow.slug,
          workflowName: workflow.name,
          actorUserId: meta?.userId,
          actorUserName,
          totalCostUsd: meta?.totalCostUsd,
          totalTokensUsed: meta?.totalTokensUsed,
        });
      } catch (err) {
        logger.warn('Webhook dispatch failed for workflow_failed', {
          failedStepId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })(),
    'Webhook dispatch for workflow_failed',
    { executionId: meta?.executionId }
  );
  return { type: 'workflow_failed', error, failedStepId };
}
