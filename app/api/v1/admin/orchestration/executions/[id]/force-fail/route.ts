/**
 * Admin Orchestration — Force-fail an execution
 *
 * POST /api/v1/admin/orchestration/executions/:id/force-fail
 *
 * Transitions a stuck `running` / `pending` / `paused_for_approval`
 * execution to `failed` with `errorMessage = 'Force-failed by admin'`
 * (plus optional reason). One-click remediation for the "my workflow
 * has been running for 20 minutes" case partners hit with cron- and
 * trigger-driven workflows.
 *
 * Side-effects:
 *   - Status flip + lease clear in one conditional updateMany so a
 *     concurrent natural completion wins gracefully (returns 409).
 *   - Running-step rows for the execution are swept in the same tx
 *     (mirrors the cancel route's invariant).
 *   - `execution.force_failed` lease event recorded (inspector visible).
 *   - Admin audit log entry written (action `execution.force_failed`).
 *   - `workflow.failed` AND `execution.force_failed` hooks emitted.
 *     The first keeps existing Slack/PagerDuty integrations firing
 *     without subscription changes; the second lets consumers
 *     distinguish admin termination from natural failure.
 *
 * Authentication: Admin role required. Ownership: same as the cancel
 * route — rows are scoped to `session.user.id`; cross-user access
 * returns 404 (not 403) so admins cannot probe for other users' rows.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { recordForceFailEvent } from '@/lib/orchestration/engine/lease';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { WorkflowStatus } from '@/types/orchestration';

const FORCE_FAILABLE_STATUSES = [
  WorkflowStatus.RUNNING,
  WorkflowStatus.PENDING,
  WorkflowStatus.PAUSED_FOR_APPROVAL,
] as const;

const ForceFailBodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsedId = cuidSchema.safeParse(rawId);
  if (!parsedId.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsedId.data;

  const { reason } = await validateRequestBody(request, ForceFailBodySchema);

  const existing = await prisma.aiWorkflowExecution.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      workflowId: true,
      status: true,
      leaseToken: true,
    },
  });
  if (!existing) {
    throw new NotFoundError(`Execution ${id} not found`);
  }
  if (existing.userId !== session.user.id) {
    // Same scoping as the cancel route — don't leak existence of other
    // users' rows. Admin role gates the endpoint; row ownership gates
    // the action.
    throw new NotFoundError(`Execution ${id} not found`);
  }

  const errorMessage = reason ? `Force-failed by admin: ${reason}` : 'Force-failed by admin';
  const priorToken = existing.leaseToken;

  // Status flip + running-step sweep in one transaction. The
  // conditional WHERE on status guarantees that a natural completion
  // racing this call wins — the updateMany sees count=0 and we return
  // 409 with the current status (read fresh after the tx).
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.aiWorkflowExecution.updateMany({
      where: { id, status: { in: [...FORCE_FAILABLE_STATUSES] } },
      data: {
        status: WorkflowStatus.FAILED,
        completedAt: new Date(),
        errorMessage,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (updated.count > 0) {
      await tx.aiWorkflowRunningStep.deleteMany({ where: { executionId: id } });
    }
    return updated;
  });

  if (result.count === 0) {
    const current = await prisma.aiWorkflowExecution.findUnique({
      where: { id },
      select: { status: true },
    });
    throw new ConflictError(
      `Execution is in a terminal state (${current?.status ?? 'unknown'}) and cannot be force-failed`
    );
  }

  // Lease event (inspector visibility) — fire-and-forget; failures
  // logged inside the helper, never block the response.
  void recordForceFailEvent(id, priorToken, 'admin-force-fail', {
    actorUserId: session.user.id,
    previousStatus: existing.status,
  });

  // Audit log. `logAdminAction` is fire-and-forget by contract — does
  // not throw to caller. Reason captured in `metadata` (sanitised).
  logAdminAction({
    userId: session.user.id,
    action: 'execution.force_failed',
    entityType: 'execution',
    entityId: id,
    entityName: existing.workflowId,
    metadata: {
      previousStatus: existing.status,
      reason: reason ?? null,
    },
    clientIp: clientIP,
  });

  // Hook events. Order doesn't matter (both are dispatched async by
  // `emitHookEvent`). `workflow.failed` keeps existing integrations
  // firing; `execution.force_failed` lets consumers distinguish admin
  // termination from natural failure. Both go through the standard
  // dispatcher (HMAC, retry, audit row) — see `lib/orchestration/hooks/registry.ts`.
  emitHookEvent('workflow.failed', {
    executionId: id,
    workflowId: existing.workflowId,
    source: 'admin-force-fail',
    errorMessage,
  });
  emitHookEvent('execution.force_failed', {
    executionId: id,
    workflowId: existing.workflowId,
    actorUserId: session.user.id,
    reason: reason ?? null,
    previousStatus: existing.status,
  });

  log.info('Execution force-failed', {
    executionId: id,
    workflowId: existing.workflowId,
    actorUserId: session.user.id,
    previousStatus: existing.status,
  });

  return successResponse({
    success: true,
    executionId: id,
    previousStatus: existing.status,
    status: WorkflowStatus.FAILED,
  });
});
