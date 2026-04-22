/**
 * Admin Orchestration — Analytics: Unanswered Questions
 *
 * GET /api/v1/admin/orchestration/analytics/unanswered
 *
 * Returns conversations where the assistant likely couldn't answer,
 * identified by hedging language in assistant replies.
 * Query params: from, to (ISO dates), agentId (CUID), limit (1-100).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { analyticsQuerySchema } from '@/lib/validations/orchestration';
import { getUnansweredQuestions } from '@/lib/orchestration/analytics';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, analyticsQuerySchema);

  const questions = await getUnansweredQuestions(query);

  return successResponse({ questions });
});
