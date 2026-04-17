/**
 * Admin Orchestration — Cost summary
 *
 * GET /api/v1/admin/orchestration/costs/summary
 *
 * Dashboard-friendly aggregation over `AiCostLog`:
 *   - today / week / month totals (UTC boundaries)
 *   - byAgent month-to-date spend + utilisation
 *   - byModel month-to-date spend
 *   - 30-day daily trend
 *
 * Admin-global (not user-scoped). No query params.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getCostSummary } from '@/lib/orchestration/llm/cost-reports';
import { computeETag, checkConditional } from '@/lib/api/etag';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const summary = await getCostSummary();

  const etag = computeETag(summary);
  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Cost summary fetched', {
    monthTotal: summary.totals.month,
    agentCount: summary.byAgent.length,
    modelCount: summary.byModel.length,
  });
  return successResponse(summary, undefined, { headers: { ETag: etag } });
});
