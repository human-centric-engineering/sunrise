/**
 * Admin Orchestration — Live engine snapshot
 *
 * GET /api/v1/admin/orchestration/executions/live
 *
 * Returns the four cards the live-engine dashboard polls every ~5s:
 * running count + age distribution, queued count + max wait, orphaned
 * (lease-expired) running count, and per-provider in-flight call
 * counts. All data is computed in `getLiveEngineSnapshot()`; this
 * route is a thin auth + envelope wrapper.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getLiveEngineSnapshot } from '@/lib/orchestration/admin/live-engine-snapshot';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const snapshot = await getLiveEngineSnapshot();
  log.info('Live engine snapshot served', {
    running: snapshot.running.count,
    queued: snapshot.queued.count,
    orphaned: snapshot.orphaned.count,
    providerCount: snapshot.providers.length,
  });
  return successResponse(snapshot);
});
