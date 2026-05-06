/**
 * Admin Orchestration — Discard workflow draft
 *
 * POST /api/v1/admin/orchestration/workflows/:id/discard-draft
 *
 * Clears `draftDefinition`. No body. The published version is unaffected.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { discardDraft } from '@/lib/orchestration/workflows/version-service';
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

  const workflow = await discardDraft({
    workflowId: id,
    userId: session.user.id,
    clientIp: clientIP,
  });

  log.info('Workflow draft discarded', {
    workflowId: id,
    adminId: session.user.id,
  });

  return successResponse(workflow);
});
