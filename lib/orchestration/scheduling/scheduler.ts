/**
 * Workflow Scheduler
 *
 * Evaluates cron expressions for workflow schedules and triggers
 * execution when due. Designed to be called periodically (e.g. every
 * minute via an external cron job or serverless timer).
 *
 * The scheduler is stateless — each `processDueSchedules()` call:
 *   1. Queries enabled schedules where `nextRunAt <= now`
 *   2. Claims each schedule via optimistic lock (prevents double-fire)
 *   3. Creates a workflow execution row and invokes the engine
 *
 * Platform-agnostic: no Next.js imports. Requires Prisma.
 */

import { CronExpressionParser } from 'cron-parser';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { WorkflowStatus, type WorkflowDefinition } from '@/types/orchestration';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

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
 * Drain the orchestration engine's async iterator, consuming all events
 * for side-effects only (DB checkpoints, status transitions).
 *
 * Runs fire-and-forget — callers use `void drainEngine(...)`.
 */
async function drainEngine(
  executionId: string,
  workflow: { id: string; slug: string },
  definition: WorkflowDefinition,
  inputData: Record<string, unknown>,
  userId: string
): Promise<void> {
  const engine = new OrchestrationEngine();
  try {
    for await (const _event of engine.execute({ id: workflow.id, definition }, inputData, {
      userId,
      resumeFromExecutionId: executionId,
    })) {
      // Events consumed for side-effects only (DB checkpoints).
    }
  } catch (err) {
    logger.error('Scheduler: engine invocation failed for execution', {
      executionId,
      workflowSlug: workflow.slug,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Find and execute all due workflow schedules.
 *
 * Should be called periodically (every ~60 seconds). Each call uses
 * optimistic locking on `nextRunAt` to prevent double-fire when
 * concurrent ticks overlap.
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
      workflow: {
        select: { id: true, slug: true, isActive: true, workflowDefinition: true },
      },
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
      const nextRunAt = getNextRunAt(schedule.cronExpression, now);
      const originalNextRunAt = schedule.nextRunAt;

      // Optimistic lock: only proceed if nextRunAt hasn't been claimed by
      // another concurrent tick. updateMany returns count = 0 if the row
      // was already updated by another process.
      const lockResult = await prisma.aiWorkflowSchedule.updateMany({
        where: { id: schedule.id, nextRunAt: originalNextRunAt },
        data: {
          lastRunAt: now,
          nextRunAt,
        },
      });

      if (lockResult.count === 0) {
        logger.info('Scheduler: schedule already claimed by another tick, skipping', {
          scheduleId: schedule.id,
        });
        result.processed--;
        continue;
      }

      // Create execution row
      const execution = await prisma.aiWorkflowExecution.create({
        data: {
          workflowId: schedule.workflow.id,
          status: WorkflowStatus.PENDING,
          inputData: schedule.inputTemplate ?? {},
          executionTrace: [],
          userId: schedule.createdBy,
        },
      });

      logger.info('Scheduler: created execution, invoking engine', {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        workflowSlug: schedule.workflow.slug,
        executionId: execution.id,
      });

      // Parse the workflow definition; mark execution failed if invalid
      const defParsed = workflowDefinitionSchema.safeParse(schedule.workflow.workflowDefinition);
      if (!defParsed.success) {
        logger.error('Scheduler: invalid workflow definition', {
          scheduleId: schedule.id,
          executionId: execution.id,
          errors: defParsed.error.issues,
        });
        await prisma.aiWorkflowExecution.update({
          where: { id: execution.id },
          data: {
            status: WorkflowStatus.FAILED,
            errorMessage: 'Invalid workflow definition',
            completedAt: new Date(),
          },
        });
        result.failed++;
        result.errors.push({
          scheduleId: schedule.id,
          error: 'Invalid workflow definition',
        });
        continue;
      }

      // Fire-and-forget — drain the engine events without blocking the tick
      void drainEngine(
        execution.id,
        schedule.workflow,
        defParsed.data as WorkflowDefinition,
        (execution.inputData ?? {}) as Record<string, unknown>,
        schedule.createdBy
      );

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

// ============================================================================
// Pending Execution Recovery
// ============================================================================

export interface PendingExecutionResult {
  recovered: number;
  failed: number;
  errors: Array<{ executionId: string; error: string }>;
}

/**
 * Recovery sweep: picks up AiWorkflowExecution rows stuck in 'pending'
 * (created by the scheduler but never started — e.g. due to a crash
 * between row creation and engine invocation) and invokes the engine.
 *
 * A staleness threshold avoids re-running rows that are still being
 * processed by the current tick.
 */
export async function processPendingExecutions(
  staleThresholdMs: number = 2 * 60 * 1000
): Promise<PendingExecutionResult> {
  const cutoff = new Date(Date.now() - staleThresholdMs);
  const result: PendingExecutionResult = { recovered: 0, failed: 0, errors: [] };

  const pending = await prisma.aiWorkflowExecution.findMany({
    where: {
      status: WorkflowStatus.PENDING,
      createdAt: { lt: cutoff },
    },
    include: {
      workflow: {
        select: { id: true, slug: true, isActive: true, workflowDefinition: true },
      },
    },
    take: 20,
  });

  for (const execution of pending) {
    try {
      if (!execution.workflow.isActive) {
        await prisma.aiWorkflowExecution.update({
          where: { id: execution.id },
          data: {
            status: WorkflowStatus.FAILED,
            errorMessage: 'Workflow deactivated',
            completedAt: new Date(),
          },
        });
        result.failed++;
        continue;
      }

      const defParsed = workflowDefinitionSchema.safeParse(execution.workflow.workflowDefinition);
      if (!defParsed.success) {
        await prisma.aiWorkflowExecution.update({
          where: { id: execution.id },
          data: {
            status: WorkflowStatus.FAILED,
            errorMessage: 'Invalid workflow definition',
            completedAt: new Date(),
          },
        });
        result.failed++;
        continue;
      }

      logger.info('Scheduler: recovering pending execution', {
        executionId: execution.id,
        workflowSlug: execution.workflow.slug,
      });

      void drainEngine(
        execution.id,
        execution.workflow,
        defParsed.data as WorkflowDefinition,
        (execution.inputData ?? {}) as Record<string, unknown>,
        execution.userId
      );

      result.recovered++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.errors.push({ executionId: execution.id, error: errorMessage });
      result.failed++;
    }
  }

  if (result.recovered > 0 || result.failed > 0) {
    logger.info('Scheduler: pending execution recovery complete', { ...result });
  }

  return result;
}
