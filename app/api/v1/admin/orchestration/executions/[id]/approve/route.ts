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
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { approveExecutionBodySchema, executionTraceSchema } from '@/lib/validations/orchestration';
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

  const body = await validateRequestBody(request, approveExecutionBodySchema);

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

  // Persist the approval payload onto the awaiting trace entry so the
  // engine can pick it up on resume.
  const trace = executionTraceSchema.parse(execution.executionTrace);
  const awaitingIdx = trace.findIndex((e) => e.status === 'awaiting_approval');
  if (awaitingIdx !== -1) {
    trace[awaitingIdx] = {
      ...trace[awaitingIdx],
      status: 'completed',
      output: body.approvalPayload ?? { approved: true, notes: body.notes ?? null },
      completedAt: new Date().toISOString(),
    };
  }

  // Use PENDING (not RUNNING) to signal "approved, ready to resume but no
  // engine attached yet". The engine's initRun() flips to RUNNING when
  // the client reconnects via ?resumeFromExecutionId=. This prevents the
  // zombie reaper from sweeping the row before reconnection.
  await prisma.aiWorkflowExecution.update({
    where: { id },
    data: {
      status: WorkflowStatus.PENDING,
      executionTrace: trace as unknown as object,
    },
  });

  log.info('execution approved', {
    executionId: id,
    userId: session.user.id,
    resumeStepId: execution.currentStep,
  });

  return successResponse({
    success: true,
    executionId: id,
    resumeStepId: execution.currentStep,
    workflowId: execution.workflowId,
  });
});
