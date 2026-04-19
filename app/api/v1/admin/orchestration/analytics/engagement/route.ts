/**
 * Admin Orchestration — Analytics: Engagement Metrics
 *
 * GET /api/v1/admin/orchestration/analytics/engagement
 *
 * Returns engagement metrics: conversation count, unique users,
 * average conversation depth, returning user rate, and daily trend.
 * Query params: from, to (ISO dates), agentId (CUID).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { analyticsQuerySchema } from '@/lib/validations/orchestration';
import { getEngagementMetrics } from '@/lib/orchestration/analytics';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, analyticsQuerySchema);

  const metrics = await getEngagementMetrics(query);

  return successResponse({ metrics });
});
