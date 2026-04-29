/**
 * Shared approval/rejection logic.
 *
 * Both admin (session-auth) and public (token-auth) endpoints delegate
 * to these functions so the DB update, trace manipulation, optimistic
 * lock, and audit logging live in one place.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { executionTraceSchema } from '@/lib/validations/orchestration';
import { WorkflowStatus } from '@/types/orchestration';

export interface ApproveOptions {
  notes?: string | null;
  approvalPayload?: Record<string, unknown> | null;
  /** Identifies who approved — e.g. "admin:userId" or "token:external" */
  actorLabel: string;
}

export interface RejectOptions {
  reason: string;
  /** Identifies who rejected — e.g. "admin:userId" or "token:external" */
  actorLabel: string;
}

export interface ApprovalResult {
  success: true;
  executionId: string;
  resumeStepId: string | null;
  workflowId: string;
}

export interface RejectionResult {
  success: true;
  executionId: string;
}

/**
 * Approve a paused execution: update trace, transition to PENDING.
 *
 * Returns the result on success, or throws:
 * - `{ code: 'NOT_FOUND' }` if execution not found
 * - `{ code: 'INVALID_STATUS' }` if not paused_for_approval
 * - `{ code: 'TRACE_CORRUPTED' }` if trace can't be parsed
 * - `{ code: 'CONCURRENT' }` if another request already approved/rejected
 */
export async function executeApproval(
  executionId: string,
  opts: ApproveOptions
): Promise<ApprovalResult> {
  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id: executionId },
  });

  if (!execution) {
    throw Object.assign(new Error(`Execution ${executionId} not found`), { code: 'NOT_FOUND' });
  }

  if (execution.status !== WorkflowStatus.PAUSED_FOR_APPROVAL) {
    throw Object.assign(new Error('Execution is not awaiting approval'), {
      code: 'INVALID_STATUS',
      currentStatus: execution.status,
    });
  }

  // Update the awaiting trace entry with the approval result
  const traceParse = executionTraceSchema.safeParse(execution.executionTrace);
  if (!traceParse.success) {
    throw Object.assign(new Error('Execution trace is corrupted'), { code: 'TRACE_CORRUPTED' });
  }

  const trace = traceParse.data;
  const awaitingIdx = trace.findIndex((e) => e.status === 'awaiting_approval');
  if (awaitingIdx === -1) {
    throw Object.assign(new Error('Execution trace has no awaiting_approval entry'), {
      code: 'TRACE_CORRUPTED',
    });
  }

  trace[awaitingIdx] = {
    ...trace[awaitingIdx],
    status: 'completed',
    output: opts.approvalPayload ?? {
      approved: true,
      notes: opts.notes ?? null,
      actor: opts.actorLabel,
    },
    completedAt: new Date().toISOString(),
  };

  // Optimistic lock: WHERE includes status to prevent double-approve
  const result = await prisma.aiWorkflowExecution.updateMany({
    where: { id: executionId, status: WorkflowStatus.PAUSED_FOR_APPROVAL },
    data: {
      status: WorkflowStatus.PENDING,
      executionTrace: trace as unknown as object,
    },
  });

  if (result.count === 0) {
    throw Object.assign(new Error('Execution was already processed'), { code: 'CONCURRENT' });
  }

  logger.info('execution approved', {
    executionId,
    actor: opts.actorLabel,
    resumeStepId: execution.currentStep,
  });

  return {
    success: true,
    executionId,
    resumeStepId: execution.currentStep,
    workflowId: execution.workflowId,
  };
}

/**
 * Reject a paused execution: transition to CANCELLED with reason.
 *
 * Throws the same error codes as `executeApproval`.
 */
export async function executeRejection(
  executionId: string,
  opts: RejectOptions
): Promise<RejectionResult> {
  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id: executionId },
  });

  if (!execution) {
    throw Object.assign(new Error(`Execution ${executionId} not found`), { code: 'NOT_FOUND' });
  }

  if (execution.status !== WorkflowStatus.PAUSED_FOR_APPROVAL) {
    throw Object.assign(new Error('Execution is not awaiting approval'), {
      code: 'INVALID_STATUS',
      currentStatus: execution.status,
    });
  }

  // Update the awaiting trace entry with the rejection result
  const traceParse = executionTraceSchema.safeParse(execution.executionTrace);
  if (!traceParse.success) {
    throw Object.assign(new Error('Execution trace is corrupted'), { code: 'TRACE_CORRUPTED' });
  }

  const trace = traceParse.data;
  const awaitingIdx = trace.findIndex((e) => e.status === 'awaiting_approval');
  if (awaitingIdx === -1) {
    throw Object.assign(new Error('Execution trace has no awaiting_approval entry'), {
      code: 'TRACE_CORRUPTED',
    });
  }

  trace[awaitingIdx] = {
    ...trace[awaitingIdx],
    status: 'rejected',
    output: {
      rejected: true,
      reason: opts.reason,
      actor: opts.actorLabel,
    },
    completedAt: new Date().toISOString(),
  };

  const result = await prisma.aiWorkflowExecution.updateMany({
    where: { id: executionId, status: WorkflowStatus.PAUSED_FOR_APPROVAL },
    data: {
      status: WorkflowStatus.CANCELLED,
      completedAt: new Date(),
      errorMessage: `Rejected: ${opts.reason}`,
      executionTrace: trace as unknown as object,
    },
  });

  if (result.count === 0) {
    throw Object.assign(new Error('Execution was already processed'), { code: 'CONCURRENT' });
  }

  logger.info('execution rejected', {
    executionId,
    actor: opts.actorLabel,
    reason: opts.reason,
  });

  return {
    success: true,
    executionId,
  };
}
