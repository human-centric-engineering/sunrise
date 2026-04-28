/**
 * Execution Reaper
 *
 * Marks stale workflow executions as `failed`. If the process restarts
 * mid-execution, a client never reconnects after approve/retry, or an
 * approval is never acted on, these rows are orphaned forever unless
 * something sweeps them. This module provides that sweep.
 *
 * Three thresholds:
 *   - `running` rows older than 30 minutes (process crash / disconnect)
 *   - `pending` rows older than 1 hour (client never reconnected after approve/retry)
 *   - `paused_for_approval` rows older than 7 days (approval never acted on)
 *
 * Called by the unified maintenance tick endpoint.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { WorkflowStatus } from '@/types/orchestration';

/** Executions running longer than this are considered zombies. */
const ZOMBIE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Pending rows older than this were never picked up by a client. */
const STALE_PENDING_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** Approval requests older than this are considered abandoned. */
const ABANDONED_APPROVAL_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ReaperResult {
  reaped: number;
  stalePending: number;
  abandonedApprovals: number;
}

/**
 * Find workflow executions stuck in `running`, `pending`, or
 * `paused_for_approval` beyond their respective thresholds and mark
 * them as `failed`.
 */
export async function reapZombieExecutions(
  thresholdMs: number = ZOMBIE_THRESHOLD_MS,
  pendingThresholdMs: number = STALE_PENDING_THRESHOLD_MS,
  approvalThresholdMs: number = ABANDONED_APPROVAL_THRESHOLD_MS
): Promise<ReaperResult> {
  const runningCutoff = new Date(Date.now() - thresholdMs);
  const pendingCutoff = new Date(Date.now() - pendingThresholdMs);
  const approvalCutoff = new Date(Date.now() - approvalThresholdMs);

  const [runningResult, pendingResult, approvalResult] = await Promise.all([
    prisma.aiWorkflowExecution.updateMany({
      where: {
        status: WorkflowStatus.RUNNING,
        // Use updatedAt (not startedAt) so resumed executions aren't
        // immediately reaped — the resume path preserves the original
        // startedAt, but updatedAt is refreshed when status flips back
        // to RUNNING.
        updatedAt: { lt: runningCutoff },
      },
      data: {
        status: WorkflowStatus.FAILED,
        completedAt: new Date(),
        errorMessage: 'Execution reaped: exceeded zombie threshold without completing',
      },
    }),
    // Use createdAt (not updatedAt) so incidental DB writes don't reset
    // the reap timer — a PENDING row should be reaped based on when it
    // was created, not when it was last touched.
    prisma.aiWorkflowExecution.updateMany({
      where: {
        status: WorkflowStatus.PENDING,
        createdAt: { lt: pendingCutoff },
      },
      data: {
        status: WorkflowStatus.FAILED,
        completedAt: new Date(),
        errorMessage:
          'Execution reaped: client did not reconnect within 1 hour after approve/retry',
      },
    }),
    prisma.aiWorkflowExecution.updateMany({
      where: {
        status: WorkflowStatus.PAUSED_FOR_APPROVAL,
        updatedAt: { lt: approvalCutoff },
      },
      data: {
        status: WorkflowStatus.FAILED,
        completedAt: new Date(),
        errorMessage: 'Execution reaped: approval not received within 7 days',
      },
    }),
  ]);

  if (runningResult.count > 0) {
    logger.warn('Reaped zombie workflow executions', { count: runningResult.count, thresholdMs });
  }
  if (pendingResult.count > 0) {
    logger.warn('Reaped stale pending executions', {
      count: pendingResult.count,
      pendingThresholdMs,
    });
  }
  if (approvalResult.count > 0) {
    logger.warn('Reaped abandoned approval executions', {
      count: approvalResult.count,
      approvalThresholdMs,
    });
  }

  return {
    reaped: runningResult.count,
    stalePending: pendingResult.count,
    abandonedApprovals: approvalResult.count,
  };
}
