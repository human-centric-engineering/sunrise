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
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
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
  if (!execution || execution.userId !== session.user.id) {
    throw new NotFoundError(`Execution ${id} not found`);
  }
  if (!CANCELLABLE_STATUSES.has(execution.status)) {
    throw new ValidationError('Execution cannot be cancelled', {
      status: [`Expected "running" or "paused_for_approval", got "${execution.status}"`],
    });
  }

  await prisma.aiWorkflowExecution.update({
    where: { id },
    data: {
      status: WorkflowStatus.CANCELLED,
      completedAt: new Date(),
      errorMessage: 'Cancelled by user',
    },
  });

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
