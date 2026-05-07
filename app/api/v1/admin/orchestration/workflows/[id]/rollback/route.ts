/**
 * Admin Orchestration — Roll back to a prior workflow version
 *
 * POST /api/v1/admin/orchestration/workflows/:id/rollback
 *
 * Creates a NEW version whose snapshot is a copy of `targetVersionId` and
 * pins `publishedVersionId` to it. The audit chain stays monotonic — old
 * version rows are never mutated.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { rollback } from '@/lib/orchestration/workflows/version-service';
import { rollbackWorkflowSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const body = await validateRequestBody(request, rollbackWorkflowSchema);

  const result = await rollback({
    workflowId: id,
    targetVersionId: body.targetVersionId,
    userId: session.user.id,
    changeSummary: body.changeSummary,
    clientIp: clientIP,
  });

  log.info('Workflow rolled back', {
    workflowId: id,
    targetVersionId: body.targetVersionId,
    newVersionId: result.version.id,
    newVersion: result.version.version,
    adminId: session.user.id,
  });

  return successResponse({
    workflow: result.workflow,
    version: result.version,
  });
});
