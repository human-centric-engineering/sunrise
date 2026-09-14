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
import { getLiveEngineSnapshot } from '@/lib/orchestration/admin/live-engine-snapshot';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  // Scope the counts so they match the executions list, the force-fail /
  // lease / cancel routes — all of which gate through the same visibility
  // clause. The session is handed over whole because that clause needs the
  // policy's answer to "may this caller see runs nobody owns", which the
  // guard has already resolved onto it. The provider in-flight counts are
  // process-wide (no user attribution available) and are intentionally not
  // scoped.
  const snapshot = await getLiveEngineSnapshot({ session });
  log.info('Live engine snapshot served', {
    running: snapshot.running.count,
    queued: snapshot.queued.count,
    orphaned: snapshot.orphaned.count,
    providerCount: snapshot.providers.length,
  });
  return successResponse(snapshot);
});
