/**
 * Execution Reaper
 *
 * Marks stale workflow executions as `failed`. If the process restarts
 * mid-execution, or an approval is never acted on, these rows are
 * orphaned forever unless something sweeps them. This module provides
 * that sweep.
 *
 * Two thresholds:
 *   - `running` rows older than 30 minutes (process crash / disconnect)
 *   - `paused_for_approval` rows older than 7 days (abandoned approval)
 *
 * Called by the unified maintenance tick endpoint.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { WorkflowStatus } from '@/types/orchestration';

/** Executions running longer than this are considered zombies. */
const ZOMBIE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Approval requests older than this are considered abandoned. */
const ABANDONED_APPROVAL_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ReaperResult {
  reaped: number;
  abandonedApprovals: number;
}

/**
 * Find workflow executions stuck in `running` or `paused_for_approval`
 * beyond their respective thresholds and mark them as `failed`.
 */
export async function reapZombieExecutions(
  thresholdMs: number = ZOMBIE_THRESHOLD_MS,
  approvalThresholdMs: number = ABANDONED_APPROVAL_THRESHOLD_MS
): Promise<ReaperResult> {
  const runningCutoff = new Date(Date.now() - thresholdMs);
  const approvalCutoff = new Date(Date.now() - approvalThresholdMs);

  const [runningResult, approvalResult] = await Promise.all([
    prisma.aiWorkflowExecution.updateMany({
      where: {
        status: WorkflowStatus.RUNNING,
        startedAt: { lt: runningCutoff },
      },
      data: {
        status: WorkflowStatus.FAILED,
        completedAt: new Date(),
        errorMessage: 'Execution reaped: exceeded zombie threshold without completing',
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
  if (approvalResult.count > 0) {
    logger.warn('Reaped abandoned approval executions', {
      count: approvalResult.count,
      approvalThresholdMs,
    });
  }

  return { reaped: runningResult.count, abandonedApprovals: approvalResult.count };
}
