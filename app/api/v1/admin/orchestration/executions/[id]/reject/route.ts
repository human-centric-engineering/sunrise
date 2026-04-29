/**
 * Admin Orchestration — Reject paused execution
 *
 * POST /api/v1/admin/orchestration/executions/:id/reject
 *
 * Transitions a `paused_for_approval` row to `cancelled` with a
 * rejection reason recorded in `errorMessage`. Unlike cancel (which is
 * an abort), reject is a deliberate review decision with a required
 * reason.
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
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { rejectExecutionBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { WorkflowStatus } from '@/types/orchestration';

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

  const body = await validateRequestBody(request, rejectExecutionBodySchema);

  const execution = await prisma.aiWorkflowExecution.findUnique({ where: { id } });
  // Cross-user → 404 (not 403). Non-paused → 404 as well: the resource in
  // the requested state doesn't exist from the client's perspective.
  if (!execution || execution.userId !== session.user.id) {
    throw new NotFoundError(`Execution ${id} not found`);
  }
  if (execution.status !== WorkflowStatus.PAUSED_FOR_APPROVAL) {
    throw new ValidationError('Execution is not awaiting approval', {
      status: [`Expected "paused_for_approval", got "${execution.status}"`],
    });
  }

  // Optimistic lock: include status in WHERE so a concurrent reject/approve
  // that already flipped the row will cause count === 0.
  const result = await prisma.aiWorkflowExecution.updateMany({
    where: { id, status: WorkflowStatus.PAUSED_FOR_APPROVAL },
    data: {
      status: WorkflowStatus.CANCELLED,
      completedAt: new Date(),
      errorMessage: `Rejected: ${body.reason}`,
    },
  });
  if (result.count === 0) {
    throw new ValidationError('Execution was already processed by another request', {
      status: ['Concurrent approval or rejection detected'],
    });
  }

  log.info('execution rejected', {
    executionId: id,
    userId: session.user.id,
    reason: body.reason,
  });

  return successResponse({
    success: true,
    executionId: id,
  });
});
