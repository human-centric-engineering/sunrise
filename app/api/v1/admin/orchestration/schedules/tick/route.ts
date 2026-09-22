/**
 * Admin Orchestration — Scheduler Tick
 *
 * POST /api/v1/admin/orchestration/schedules/tick
 *
 * Processes all due workflow schedules. Designed to be called every
 * ~60 seconds by an external cron job (e.g. Vercel Cron, Railway Cron,
 * or a simple `curl` from system crontab). The unified maintenance tick
 * (`../maintenance/tick`) is the preferred entry point; this one remains
 * for callers that only want the schedules sweep.
 *
 * Runs the sweep per org (§108 t-711), exactly as the maintenance tick
 * does: a due schedule's execution — and everything the engine writes for
 * it — must carry the schedule's org, and the sweep must not run inside the
 * calling admin's session org. At `TENANCY_MODE=single` the response is the
 * sweep's own counters; at `multi` with several orgs it is the fold across
 * them (`orgs`, summed counters, concatenated `errors`, any `orgErrors`).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { processDueSchedules } from '@/lib/orchestration/scheduling';
import { runScopedJob } from '@/lib/orchestration/maintenance/job-scope';

export const POST = withAdminAuth(async (_request) => {
  const { result } = await runScopedJob({
    name: 'schedules',
    scope: 'per-org',
    run: processDueSchedules,
    foundWork: (r) => r.processed > 0,
  });

  return successResponse({ ...result });
});
