/**
 * Workflow Scheduler
 *
 * Evaluates cron expressions for workflow schedules and triggers
 * execution when due. Designed to be called periodically (e.g. every
 * minute via an external cron job or serverless timer).
 *
 * The scheduler is stateless — each `processDueSchedules()` call:
 *   1. Queries enabled schedules where `nextRunAt <= now`
 *   2. For each due schedule, triggers the linked workflow
 *   3. Updates `lastRunAt` and computes the next `nextRunAt`
 *
 * Platform-agnostic: no Next.js imports. Requires Prisma.
 */

import { CronExpressionParser } from 'cron-parser';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Compute the next run time from a cron expression, relative to a base date.
 * Returns null if the expression is invalid.
 */
export function getNextRunAt(cronExpression: string, from: Date = new Date()): Date | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression, { currentDate: from });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Validate a cron expression. Returns true if parseable.
 */
export function isValidCron(cronExpression: string): boolean {
  try {
    CronExpressionParser.parse(cronExpression);
    return true;
  } catch {
    return false;
  }
}

export interface ScheduleProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ scheduleId: string; error: string }>;
}

/**
 * Find and execute all due workflow schedules.
 *
 * Should be called periodically (every ~60 seconds). Each call is
 * idempotent — `nextRunAt` is updated atomically so concurrent calls
 * won't double-fire.
 */
export async function processDueSchedules(): Promise<ScheduleProcessResult> {
  const now = new Date();
  const result: ScheduleProcessResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  // Find enabled schedules that are due
  const dueSchedules = await prisma.aiWorkflowSchedule.findMany({
    where: {
      isEnabled: true,
      nextRunAt: { lte: now },
    },
    include: {
      workflow: { select: { id: true, slug: true, isActive: true } },
    },
    take: 50, // Process at most 50 per tick to prevent overload
  });

  for (const schedule of dueSchedules) {
    result.processed++;

    // Skip inactive workflows
    if (!schedule.workflow.isActive) {
      logger.warn('Scheduler: skipping schedule for inactive workflow', {
        scheduleId: schedule.id,
        workflowSlug: schedule.workflow.slug,
      });
      continue;
    }

    try {
      // Atomically update nextRunAt to prevent double-fire
      const nextRunAt = getNextRunAt(schedule.cronExpression, now);

      await prisma.aiWorkflowSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: now,
          nextRunAt,
        },
      });

      // Create a workflow execution
      await prisma.aiWorkflowExecution.create({
        data: {
          workflowId: schedule.workflow.id,
          status: 'pending',
          inputData: schedule.inputTemplate ?? {},
          executionTrace: [],
          userId: schedule.createdBy,
        },
      });

      logger.info('Scheduler: triggered workflow execution', {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        workflowSlug: schedule.workflow.slug,
      });

      result.succeeded++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Scheduler: failed to trigger workflow', {
        scheduleId: schedule.id,
        error: errorMessage,
      });
      result.failed++;
      result.errors.push({ scheduleId: schedule.id, error: errorMessage });
    }
  }

  if (result.processed > 0) {
    logger.info('Scheduler: tick complete', {
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
    });
  }

  return result;
}
