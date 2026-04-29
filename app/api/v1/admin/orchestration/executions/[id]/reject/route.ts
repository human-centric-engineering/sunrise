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
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { rejectExecutionBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { executeRejection } from '@/lib/orchestration/approval-actions';
import { isApproverInTrace } from '@/lib/orchestration/approval-scoping';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const body = await validateRequestBody(request, rejectExecutionBodySchema);

  // Ownership + approver scoping check
  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id },
    select: { userId: true, executionTrace: true },
  });
  if (!execution) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  // Allow if the user owns the execution or is in the approverUserIds list
  const isOwner = execution.userId === session.user.id;
  const isApprover = !isOwner && isApproverInTrace(execution.executionTrace, session.user.id);
  if (!isOwner && !isApprover) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  try {
    const result = await executeRejection(id, {
      reason: body.reason,
      actorLabel: `admin:${session.user.id}`,
    });
    return successResponse(result);
  } catch (err) {
    const error = err as Error & { code?: string; currentStatus?: string };
    switch (error.code) {
      case 'NOT_FOUND':
        throw new NotFoundError(error.message);
      case 'INVALID_STATUS':
        throw new ValidationError('Execution is not awaiting approval', {
          status: [`Expected "paused_for_approval", got "${error.currentStatus}"`],
        });
      case 'TRACE_CORRUPTED':
        throw new ValidationError('Execution trace is corrupted and cannot be modified');
      case 'CONCURRENT':
        throw new ConflictError('Execution was already processed by another request');
      default:
        throw err;
    }
  }
});
