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
import { analyticsQuerySchema } from '@/lib/validations/orchestration';
import { getEngagementMetrics } from '@/lib/orchestration/analytics';

export const GET = withAdminAuth(async (request, session) => {
  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, analyticsQuerySchema);

  const metrics = await getEngagementMetrics(query, session);

  return successResponse({ metrics });
});
