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
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
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

/**
 * Sanitise an error message before sending it to outbound hook subscribers.
 *
 * Webhook receivers are admin-trusted but may forward to broader-audience
 * destinations (Slack channels, third-party automation platforms). Raw JS
 * error messages from an engine crash can contain absolute filesystem paths,
 * stack-derived internal references, or kilobytes of detail that nobody
 * outside the platform should see. This helper strips obvious leaks and
 * caps the length.
 *
 * The full unsanitised message is still persisted to `AiWorkflowExecution.errorMessage`
 * so admins can inspect it via the admin UI; only the hook payload is curated.
 *
 * Exported for unit testing.
 */
const HOOK_ERROR_MAX_LEN = 200;
const ABS_PATH_PATTERN = /(?:\/[\w.@-]+)+|[A-Za-z]:\\[\w.@\\-]+/g;

export function sanitiseHookErrorMessage(message: string): string {
  const noPaths = message.replace(ABS_PATH_PATTERN, '<path>');
  if (noPaths.length <= HOOK_ERROR_MAX_LEN) return noPaths;
  return noPaths.slice(0, HOOK_ERROR_MAX_LEN - 1) + '…';
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
 *
 * On uncaught engine errors, the row is marked FAILED and the
 * `workflow.execution.failed` hook is emitted. The engine's own
 * `workflow.failed` hook is NOT emitted on this path because
 * `finalize()` never ran — see `lib/orchestration/engine/orchestration-engine.ts`.
 *
 * Exported so the inbound-trigger route can drain immediately on receipt
 * (rather than waiting for the next maintenance tick) — the crash-handling
 * and hook-emission semantics are identical for both entry points.
 */
export async function drainEngine(
  executionId: string,
  workflow: { id: string; slug: string },
  definition: WorkflowDefinition,
  inputData: Record<string, unknown>,
  userId: string,
  versionId: string | null
): Promise<void> {
  const engine = new OrchestrationEngine();
  try {
    for await (const _event of engine.execute(
      { id: workflow.id, definition, versionId: versionId ?? undefined },
      inputData,
      {
        userId,
        resumeFromExecutionId: executionId,
      }
    )) {
      // Events consumed for side-effects only (DB checkpoints).
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('Scheduler: engine invocation failed for execution', {
      executionId,
      workflowSlug: workflow.slug,
      error: errorMessage,
    });

    // finalize() never ran — repair the row so /status and the hook payload
    // agree. The zombie reaper remains the safety net if this also fails.
    // Lease columns are cleared alongside the FAILED flip so an orphan-resume
    // run that crashed pre-finalize doesn't leave a stale lease pinned to the
    // terminal row (which would block any future re-claim until natural expiry).
    try {
      await prisma.aiWorkflowExecution.update({
        where: { id: executionId },
        data: {
          status: WorkflowStatus.FAILED,
          errorMessage,
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    } catch (updateErr) {
      logger.error('Scheduler: failed to mark crashed execution as failed', {
        executionId,
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    }

    const sanitisedError = sanitiseHookErrorMessage(errorMessage);
    const crashPayload = {
      executionId,
      workflowId: workflow.id,
      workflowSlug: workflow.slug,
      userId,
      error: sanitisedError,
    };

    // Mirror the crash to both notification subsystems:
    //   1. Event hooks (in-process, filterable, lightweight)
    //   2. Webhook subscriptions (durable per-delivery audit, admin-UI configurable)
    // Admins can subscribe via either system depending on their delivery
    // requirements. Both payloads carry the sanitised error.
    emitHookEvent('workflow.execution.failed', crashPayload);
    void dispatchWebhookEvent('execution_crashed', crashPayload).catch((dispatchErr) => {
      logger.warn('Webhook dispatch failed for execution_crashed', {
        executionId,
        error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
      });
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
        select: {
          id: true,
          slug: true,
          isActive: true,
          publishedVersion: { select: { id: true, snapshot: true } },
        },
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

      // Resolve the published version; bail before the execution row is
      // created if no version is pinned. Without this guard the row would be
      // inserted then immediately marked FAILED.
      const publishedVersion = schedule.workflow.publishedVersion;
      if (!publishedVersion) {
        logger.error('Scheduler: workflow has no published version', {
          scheduleId: schedule.id,
          workflowSlug: schedule.workflow.slug,
        });
        result.failed++;
        result.errors.push({
          scheduleId: schedule.id,
          error: 'Workflow has no published version',
        });
        continue;
      }

      // Create execution row, pinned to the resolved version
      const execution = await prisma.aiWorkflowExecution.create({
        data: {
          workflowId: schedule.workflow.id,
          versionId: publishedVersion.id,
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
        versionId: publishedVersion.id,
      });

      // Parse the workflow definition; mark execution failed if invalid
      const defParsed = workflowDefinitionSchema.safeParse(publishedVersion.snapshot);
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
        schedule.createdBy,
        publishedVersion.id
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
 * Fire-and-forget kick off the engine to resume an execution that was
 * just transitioned out of `paused_for_approval` (typically by a
 * channel-specific approval route — chat or embed — where the user is
 * actively waiting for the workflow to complete).
 *
 * The standard admin-queue flow expects the client to reconnect via
 * `?resumeFromExecutionId=` on the workflow execute route, which is
 * why `executeApproval` doesn't auto-resume. Channel-specific routes
 * call this so chat-rendered cards don't have to wait on the
 * maintenance tick (`processPendingExecutions`, ~2 minute stale
 * threshold + ~60s tick interval) before the workflow restarts.
 *
 * Race-safe with `processPendingExecutions`: by the time the
 * maintenance tick fires, this run will have already transitioned
 * status from `pending` to `running` (via `engine.execute`'s
 * `initRun`), and the maintenance tick's `where: { status: PENDING }`
 * filter excludes the row. If this drain crashes mid-run, the
 * `reapZombieExecutions` task remains the safety net.
 */
export async function resumeApprovedExecution(executionId: string): Promise<void> {
  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id: executionId },
    include: {
      workflow: {
        select: {
          id: true,
          slug: true,
          isActive: true,
          publishedVersion: { select: { id: true, snapshot: true } },
        },
      },
      version: { select: { id: true, snapshot: true } },
    },
  });
  if (!execution) return;

  // Workflow deactivated between pause and approval. Without this
  // explicit mark-failed, the run would sit in PENDING until the
  // maintenance tick cleaned it up (2-min stale threshold + ~60s
  // tick interval) — long enough for the chat card's polling budget
  // to expire, leaving the user with no terminal signal.
  if (!execution.workflow.isActive) {
    logger.warn('resumeApprovedExecution: workflow deactivated, marking failed', {
      executionId,
      workflowSlug: execution.workflow.slug,
    });
    await prisma.aiWorkflowExecution
      .updateMany({
        where: { id: executionId, status: WorkflowStatus.PENDING },
        data: {
          status: WorkflowStatus.FAILED,
          errorMessage: 'Workflow deactivated',
          completedAt: new Date(),
        },
      })
      .catch((err: unknown) => {
        logger.error('resumeApprovedExecution: mark-failed update failed', err, { executionId });
      });
    return;
  }

  // Prefer the pinned version on the execution row; fall back to the workflow's
  // current published version for legacy rows that pre-date pinning.
  const pinnedSnapshot =
    execution.version?.snapshot ?? execution.workflow.publishedVersion?.snapshot;
  const pinnedVersionId = execution.versionId ?? execution.workflow.publishedVersion?.id ?? null;
  if (!pinnedSnapshot) {
    logger.error('resumeApprovedExecution: no version snapshot to resume', undefined, {
      executionId,
    });
    return;
  }

  const defParsed = workflowDefinitionSchema.safeParse(pinnedSnapshot);
  if (!defParsed.success) {
    logger.error('resumeApprovedExecution: invalid workflow definition', undefined, {
      executionId,
      issues: defParsed.error.issues,
    });
    return;
  }

  void drainEngine(
    executionId,
    execution.workflow,
    defParsed.data as WorkflowDefinition,
    (execution.inputData ?? {}) as Record<string, unknown>,
    execution.userId,
    pinnedVersionId
  );
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
        select: {
          id: true,
          slug: true,
          isActive: true,
          publishedVersion: { select: { id: true, snapshot: true } },
        },
      },
      version: { select: { id: true, snapshot: true } },
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

      // Prefer the pinned version snapshot; legacy rows fall back to current published.
      const pinnedSnapshot =
        execution.version?.snapshot ?? execution.workflow.publishedVersion?.snapshot;
      const pinnedVersionId =
        execution.versionId ?? execution.workflow.publishedVersion?.id ?? null;
      if (!pinnedSnapshot) {
        await prisma.aiWorkflowExecution.update({
          where: { id: execution.id },
          data: {
            status: WorkflowStatus.FAILED,
            errorMessage: 'No published version to resume',
            completedAt: new Date(),
          },
        });
        result.failed++;
        continue;
      }

      const defParsed = workflowDefinitionSchema.safeParse(pinnedSnapshot);
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
        execution.userId,
        pinnedVersionId
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

// ============================================================================
// Orphaned Execution Recovery (lease-aware)
// ============================================================================

/**
 * Cap on automatic recovery attempts per execution. After this many re-drives the
 * orphan sweep marks the row FAILED rather than entering an indefinite retry loop.
 * The cap protects against deterministic-failure runs that would otherwise eat the
 * tick budget forever — a workflow that crashes the same way each restart should
 * surface to operators, not loop silently.
 */
export const MAX_RECOVERY_ATTEMPTS = 3;

export interface OrphanSweepResult {
  recovered: number;
  exhausted: number;
  errors: Array<{ executionId: string; error: string }>;
}

/**
 * Recovery sweep: picks up `running` rows whose lease has expired (the host driving
 * them died or stalled) and re-drives them through the standard resume path. Rows
 * that have already been re-driven `MAX_RECOVERY_ATTEMPTS` times are marked FAILED
 * with a `recovery_exhausted` reason instead.
 *
 * Detection cadence: orphans are picked up within `LEASE_DURATION_MS` (3 min) of
 * the host stopping its heartbeat — far quicker than the 30-min zombie reaper, so
 * users see resumed runs near-real-time after a deploy or crash.
 *
 * Race-safe with concurrent ticks: the resume path inside the engine claims the
 * lease atomically (`claimLease`). If two sweeps query the same orphan, only one
 * `drainEngine` call wins the claim — the other throws a "lease conflict on resume"
 * caught by `drainEngine` and logged.
 *
 * Why this lives in the scheduler (not the reaper): semantically it's "rows we want
 * to ATTEMPT to drive" — same shape as `processPendingExecutions`. The reaper holds
 * "rows we want to MARK FAILED" (zombies past 30 min, abandoned approvals past 7
 * days). Splitting along that line keeps each module's responsibility clean.
 */
export async function processOrphanedExecutions(): Promise<OrphanSweepResult> {
  const now = new Date();
  const result: OrphanSweepResult = { recovered: 0, exhausted: 0, errors: [] };

  const orphans = await prisma.aiWorkflowExecution.findMany({
    where: {
      status: WorkflowStatus.RUNNING,
      leaseExpiresAt: { lt: now },
    },
    include: {
      workflow: {
        select: {
          id: true,
          slug: true,
          isActive: true,
          publishedVersion: { select: { id: true, snapshot: true } },
        },
      },
      version: { select: { id: true, snapshot: true } },
    },
    take: 20,
  });

  for (const execution of orphans) {
    try {
      // Recovery exhaustion — past the cap. Mark FAILED and emit the failure hook
      // so operator alerts fire. The terminal write is unconditional (no lease
      // guard) because by definition the lease is gone.
      if (execution.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        const errorMessage = `Recovery exhausted after ${execution.recoveryAttempts} attempts`;
        await prisma.aiWorkflowExecution.update({
          where: { id: execution.id },
          data: {
            status: WorkflowStatus.FAILED,
            errorMessage,
            completedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        const sanitisedError = sanitiseHookErrorMessage(errorMessage);
        const crashPayload = {
          executionId: execution.id,
          workflowId: execution.workflow.id,
          workflowSlug: execution.workflow.slug,
          userId: execution.userId,
          error: sanitisedError,
        };
        emitHookEvent('workflow.execution.failed', crashPayload);
        // Fire-and-forget: dispatchWebhookEvent records the delivery attempt to its retry
        // queue BEFORE the network call, so a rejection here means the delivery is already
        // queued for retry. Awaiting would couple sweep latency to webhook-receiver health,
        // which is wrong — the receiver retry loop is decoupled by design.
        void dispatchWebhookEvent('execution_crashed', crashPayload).catch((err: unknown) => {
          logger.warn('Webhook dispatch failed for execution_crashed (recovery exhausted)', {
            executionId: execution.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        result.exhausted++;
        continue;
      }

      // Same defensive checks as processPendingExecutions: skip+fail if the workflow
      // was deactivated, has no version snapshot, or has an invalid definition.
      if (!execution.workflow.isActive) {
        await prisma.aiWorkflowExecution.update({
          where: { id: execution.id },
          data: {
            status: WorkflowStatus.FAILED,
            errorMessage: 'Workflow deactivated',
            completedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        result.errors.push({ executionId: execution.id, error: 'Workflow deactivated' });
        continue;
      }

      const pinnedSnapshot =
        execution.version?.snapshot ?? execution.workflow.publishedVersion?.snapshot;
      const pinnedVersionId =
        execution.versionId ?? execution.workflow.publishedVersion?.id ?? null;
      if (!pinnedSnapshot) {
        await prisma.aiWorkflowExecution.update({
          where: { id: execution.id },
          data: {
            status: WorkflowStatus.FAILED,
            errorMessage: 'No published version to resume',
            completedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        result.errors.push({
          executionId: execution.id,
          error: 'No published version to resume',
        });
        continue;
      }

      const defParsed = workflowDefinitionSchema.safeParse(pinnedSnapshot);
      if (!defParsed.success) {
        await prisma.aiWorkflowExecution.update({
          where: { id: execution.id },
          data: {
            status: WorkflowStatus.FAILED,
            errorMessage: 'Invalid workflow definition',
            completedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        result.errors.push({ executionId: execution.id, error: 'Invalid workflow definition' });
        continue;
      }

      logger.info('Scheduler: re-driving orphaned execution', {
        executionId: execution.id,
        workflowSlug: execution.workflow.slug,
        priorRecoveryAttempts: execution.recoveryAttempts,
      });

      // Fire-and-forget drain. `initRun`'s resume branch claims the lease and
      // increments `recoveryAttempts` atomically; if another sweep beat us to the
      // claim, drainEngine's catch logs and the row stays running under the new owner.
      void drainEngine(
        execution.id,
        execution.workflow,
        defParsed.data as WorkflowDefinition,
        (execution.inputData ?? {}) as Record<string, unknown>,
        execution.userId,
        pinnedVersionId
      );

      result.recovered++;
    } catch (err) {
      // Per-row throw is intentionally not terminal — the next maintenance tick re-queries
      // the same orphans (status=running AND leaseExpiresAt < now) and retries. This handles
      // transient DB blips without a separate "permanently unrecoverable" state, bounded by
      // recoveryAttempts vs. MAX_RECOVERY_ATTEMPTS.
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.errors.push({ executionId: execution.id, error: errorMessage });
    }
  }

  if (result.recovered > 0 || result.exhausted > 0 || result.errors.length > 0) {
    logger.info('Scheduler: orphan sweep complete', {
      recovered: result.recovered,
      exhausted: result.exhausted,
      errors: result.errors.length,
    });
  }

  return result;
}
