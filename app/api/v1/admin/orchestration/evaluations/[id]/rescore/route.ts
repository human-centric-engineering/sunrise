/**
 * Admin Orchestration — Re-score evaluation session
 *
 * POST /api/v1/admin/orchestration/evaluations/:id/rescore
 *
 * Re-runs the named-metric scorer (faithfulness, groundedness,
 * relevance) over an already-completed evaluation session. Overwrites
 * per-log scores in place and accumulates `totalScoringCostUsd` on the
 * session's `metricSummary`. Useful after a knowledge-base update,
 * prompt tweak, or judge-model swap.
 *
 * Ownership is enforced inside `rescoreEvaluationSession`; missing /
 * cross-user sessions throw `NotFoundError` (404 not 403). Sessions
 * that aren't `completed` throw `ConflictError` (409).
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
import { rescoreEvaluationBodySchema } from '@/lib/validations/orchestration';
import { rescoreEvaluationSession } from '@/lib/orchestration/evaluations';

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

  // Tolerate empty body — schema accepts {}.
  const cloned = request.clone();
  const rawText = await cloned.text();
  if (rawText.trim().length > 0) {
    await validateRequestBody(request, rescoreEvaluationBodySchema);
  }

  const result = await rescoreEvaluationSession({
    sessionId,
    userId: session.user.id,
  });

  log.info('Evaluation session re-scored', {
    sessionId,
    scoredLogCount: result.metricSummary.scoredLogCount,
  });

  return successResponse({ session: result });
});
