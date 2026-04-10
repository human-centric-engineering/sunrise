/**
 * Admin Orchestration — Complete evaluation session
 *
 * POST /api/v1/admin/orchestration/evaluations/:id/complete
 *
 * Triggers the AI analysis pass: bounded prompt from the session's
 * logs, one non-streaming LLM call, JSON-parsed summary +
 * improvement suggestions, session update to `completed`, cost row
 * logged as `operation=evaluation`. Synchronous — not SSE.
 *
 * Ownership is enforced inside `completeEvaluationSession`; missing /
 * cross-user sessions throw `NotFoundError` (404 not 403).
 *
 * Raw LLM / provider errors are NEVER forwarded in the response;
 * the handler sanitizes them to a generic message and logs the
 * details server-side.
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
import { cuidSchema } from '@/lib/validations/common';
import { completeEvaluationBodySchema } from '@/lib/validations/orchestration';
import { completeEvaluationSession } from '@/lib/orchestration/evaluations';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid evaluation id', { id: ['Must be a valid CUID'] });
  }
  const sessionId = parsed.data;

  // Tolerate an empty body. `completeEvaluationBodySchema` accepts `{}`.
  await validateRequestBody(request, completeEvaluationBodySchema).catch(() => ({}));

  const result = await completeEvaluationSession({
    sessionId,
    userId: session.user.id,
  });

  log.info('Evaluation session completed', {
    sessionId,
    tokenUsage: result.tokenUsage,
  });

  return successResponse({ session: result });
});
