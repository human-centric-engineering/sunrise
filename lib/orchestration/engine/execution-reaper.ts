/**
 * Execution Reaper
 *
 * Marks stale `running` workflow executions as `failed`. If the process
 * restarts mid-execution, these rows are orphaned forever unless
 * something sweeps them. This module provides that sweep.
 *
 * Called by the unified maintenance tick endpoint.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/** Executions running longer than this are considered zombies. */
const ZOMBIE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export interface ReaperResult {
  reaped: number;
}

/**
 * Find workflow executions stuck in `running` status beyond the
 * zombie threshold and mark them as `failed`.
 */
export async function reapZombieExecutions(
  thresholdMs: number = ZOMBIE_THRESHOLD_MS
): Promise<ReaperResult> {
  const cutoff = new Date(Date.now() - thresholdMs);

  const result = await prisma.aiWorkflowExecution.updateMany({
    where: {
      status: 'running',
      startedAt: { lt: cutoff },
    },
    data: {
      status: 'failed',
      completedAt: new Date(),
    },
  });

  if (result.count > 0) {
    logger.warn('Reaped zombie workflow executions', { count: result.count, thresholdMs });
  }

  return { reaped: result.count };
}
