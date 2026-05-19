/**
 * Admin Orchestration — Cancel a running execution
 *
 * POST /api/v1/admin/orchestration/executions/:id/cancel
 *
 * Transitions a `running` or `paused_for_approval` execution to
 * `cancelled` and records `completedAt`. The engine polls execution
 * status between steps and will stop when it sees `cancelled`.
 *
 * Ownership: rows are scoped to `session.user.id`. Cross-user access
 * returns 404 (not 403).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { isApproverInTrace } from '@/lib/orchestration/approval-scoping';
import { WorkflowStatus } from '@/types/orchestration';

const CANCELLABLE_STATUSES = new Set<string>([
  WorkflowStatus.RUNNING,
  WorkflowStatus.PAUSED_FOR_APPROVAL,
]);

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const execution = await prisma.aiWorkflowExecution.findUnique({ where: { id } });
  if (!execution) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  // Ownership + approver scoping: delegated approvers can cancel paused executions only
  const isOwner = execution.userId === session.user.id;
  const isApprover =
    !isOwner &&
    execution.status === WorkflowStatus.PAUSED_FOR_APPROVAL &&
    isApproverInTrace(execution.executionTrace, session.user.id);
  if (!isOwner && !isApprover) {
    throw new NotFoundError(`Execution ${id} not found`);
  }
  if (!CANCELLABLE_STATUSES.has(execution.status)) {
    throw new ValidationError('Execution cannot be cancelled', {
      status: [`Expected "running" or "paused_for_approval", got "${execution.status}"`],
    });
  }

  // Status flip and running-step sweep in one transaction. The engine's
  // `finalize` may not run here (cancel races the lease) so the route
  // takes responsibility for clearing the in-flight rows directly. The
  // delete is conditional on the status guard matching so a no-op
  // cancellation doesn't sweep rows still being driven by another path.
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.aiWorkflowExecution.updateMany({
      where: { id, status: { in: [...CANCELLABLE_STATUSES] } },
      data: {
        status: WorkflowStatus.CANCELLED,
        completedAt: new Date(),
        errorMessage: 'Cancelled by user',
      },
    });
    if (updated.count > 0) {
      await tx.aiWorkflowRunningStep.deleteMany({ where: { executionId: id } });
    }
    return updated;
  });

  if (result.count === 0) {
    throw new ConflictError('Execution status changed before cancellation could complete');
  }

  log.info('execution cancelled', {
    executionId: id,
    userId: session.user.id,
    previousStatus: execution.status,
  });

  return successResponse({
    success: true,
    executionId: id,
  });
});
