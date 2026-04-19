/**
 * Admin Orchestration — Analytics: Feedback Summary
 *
 * GET /api/v1/admin/orchestration/analytics/feedback
 *
 * Aggregates message ratings (thumbs up/down) by agent and overall.
 * Query params: from, to (ISO dates), agentId (CUID), limit (1-100).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { analyticsQuerySchema } from '@/lib/validations/orchestration';
import { getFeedbackSummary } from '@/lib/orchestration/analytics';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, analyticsQuerySchema);

  const feedback = await getFeedbackSummary(query);

  return successResponse({ feedback });
});
