/**
 * Admin Orchestration — Approve paused execution
 *
 * POST /api/v1/admin/orchestration/executions/:id/approve
 *
 * Transitions a `paused_for_approval` row back to `running` and writes
 * the approval payload onto the awaiting step's trace entry so the
 * engine sees it when the client reconnects via
 * `POST /workflows/:workflowId/execute?resumeFromExecutionId=<id>`.
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
import { approveExecutionBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { executeApproval } from '@/lib/orchestration/approval-actions';

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

  const body = await validateRequestBody(request, approveExecutionBodySchema);

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
  let isApprover = false;
  if (!isOwner && Array.isArray(execution.executionTrace)) {
    const trace = execution.executionTrace as Array<Record<string, unknown>>;
    const awaitingEntry = trace.find((e) => e.status === 'awaiting_approval');
    const output = awaitingEntry?.output as Record<string, unknown> | undefined;
    const approverIds = output?.approverUserIds;
    if (Array.isArray(approverIds) && approverIds.includes(session.user.id)) {
      isApprover = true;
    }
  }
  if (!isOwner && !isApprover) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  try {
    const result = await executeApproval(id, {
      notes: body.notes,
      approvalPayload: body.approvalPayload,
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
        throw new ConflictError('Execution was already approved by another request');
      default:
        throw err;
    }
  }
});
