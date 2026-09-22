/**
 * Unified Maintenance Tick — HTTP entry point.
 *
 * POST /api/v1/admin/orchestration/maintenance/tick
 *
 * Designed to be called every ~60s by an external cron job. Returns
 * 202 once `processDueSchedules()` has claimed and fired any due
 * schedules; the remaining nine tasks run as a background chain
 * inside the same overlap guard, each inside its own tenant scope (§108). A tick that the idle gate has
 * already accounted for returns 200 `{ skipped: true, reason: 'idle' }`
 * without touching the database; `?force=1` overrides that. See
 * `lib/orchestration/maintenance/run-tick.ts` for the task list and
 * the guard / watchdog mechanics — both this route and the dev-only
 * `instrumentation.ts` setInterval share that body.
 *
 * Auth: Admin role required (session or API key with admin scope).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import {
  BACKGROUND_TASK_NAMES,
  runMaintenanceTick,
  __test_setTickRunning as sharedTestSetTickRunning,
} from '@/lib/orchestration/maintenance/run-tick';

/** Exposed for testing only — simulate an in-progress tick. */
export const __test_setTickRunning = sharedTestSetTickRunning;

export const POST = withAdminAuth(async (request) => {
  // `?force=1` sweeps even when the idle gate is armed (#442) — for an operator
  // who wants a guaranteed sweep now. It does not bypass the overlap guard.
  const force = new URL(request.url).searchParams.get('force') === '1';
  const result = await runMaintenanceTick({ force });

  if (result.skipped) {
    return successResponse({
      skipped: true,
      reason: result.reason,
      ...(result.resumesAtMs ? { resumesAt: new Date(result.resumesAtMs).toISOString() } : {}),
    });
  }

  return successResponse(
    {
      schedules: result.schedules,
      backgroundTasks: BACKGROUND_TASK_NAMES,
      durationMs: Date.now() - result.startMs,
    },
    undefined,
    { status: 202 }
  );
});
