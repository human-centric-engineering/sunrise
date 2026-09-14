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
 * Ownership: the caller's own runs, plus system-owned runs (`userId = null`
 * — schedule- and inbound-triggered). Another admin's own run returns 404
 * (not 403) — we never confirm existence of a row the caller cannot see.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { rejectExecutionBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { executeRejection } from '@/lib/orchestration/approval-actions';
import { isApproverInTrace } from '@/lib/orchestration/approval-scoping';
import { adminCanViewExecution } from '@/lib/orchestration/access/execution-access';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
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

  // Allow if the caller may see the run — their own, or system-owned
  // (schedule- / inbound-triggered, `userId = null`) — or is in the
  // approverUserIds list. The system basis matters most here: a
  // system-owned run has no owner to fall back on, so without it an
  // approval gate reached by a scheduled or inbound run could never be
  // cleared by anyone (#502).
  const canAct = adminCanViewExecution(execution, session);
  const isApprover = !canAct && isApproverInTrace(execution.executionTrace, session.user.id);
  if (!canAct && !isApprover) {
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
