/**
 * Admin Orchestration — Approve paused execution (STUB, 501)
 *
 * POST /api/v1/admin/orchestration/executions/:id/approve
 *
 * Validates auth, body shape, URL id, and execution lookup, then
 * returns 501. Deliberately does NOT check
 * `execution.status === 'paused_for_approval'` — state-transition logic
 * belongs with the real engine (Session 5.2), which is the source of
 * truth on approval lifecycle.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { approveExecutionBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

const NOT_IMPLEMENTED_MESSAGE = 'Workflow execution engine arrives in Phase 5 (Session 5.2)';

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
  if (!execution) throw new NotFoundError(`Execution ${id} not found`);

  log.warn('execution approve stubbed — 501', {
    executionId: id,
    userId: session.user.id,
    hasPayload: body.approvalPayload !== undefined,
  });

  // TODO(Session 5.2): replace this 501 with
  //   return successResponse(
  //     await engine.resumeApproval(id, session.user.id, body.approvalPayload)
  //   );
  return errorResponse(NOT_IMPLEMENTED_MESSAGE, {
    code: 'NOT_IMPLEMENTED',
    status: 501,
  });
});
