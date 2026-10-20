/**
 * Unified Maintenance Tick — HTTP entry point.
 *
 * POST /api/v1/admin/orchestration/maintenance/tick
 * GET  /api/v1/admin/orchestration/maintenance/tick  (admin API key only)
 *
 * Designed to be called every ~60s by an external cron job — required on
 * every production host, since the in-process ticker runs only in
 * development. Returns 202 once `processDueSchedules()` has claimed and fired
 * any due schedules; the remaining tasks run as a background chain inside the
 * same overlap guard, each inside its own tenant scope (§108). A tick that the
 * idle gate has already accounted for returns 200 `{ skipped: true, reason:
 * 'idle' }` without touching the database; `?force=1` overrides that. See
 * `lib/orchestration/maintenance/run-tick.ts` for the task list and the guard
 * / watchdog mechanics — both this route and the dev-only `instrumentation.ts`
 * setInterval share that body.
 *
 * **The background chain runs under `after()` (t-844).** On a serverless host
 * the invocation can be frozen as soon as the response is sent; `after()`
 * keeps it alive until the chain settles, for up to `maxDuration`.
 *
 * **No HEAD.** Next answers an unexported HEAD by running the GET handler, so
 * an uptime probe holding the cron key would fire a full tick. HEAD answers
 * 405 instead.
 *
 * **Why a GET.** Vercel Cron only sends GET, with `Authorization: Bearer
 * $CRON_SECRET`. Setting `CRON_SECRET` to an admin API key lets it call this
 * route with no proxy in between. The GET refuses a browser session: a session
 * cookie rides along on a top-level cross-site navigation, so a GET that
 * accepted one would let any page make an admin's browser fire a tick. A
 * bearer header cannot be set that way.
 *
 * Auth: Admin role required (session or API key with admin scope; GET takes
 * the API key only).
 */

import type { NextRequest } from 'next/server';
import { withAdminAuth, type AuthenticatedSession } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { successResponse } from '@/lib/api/responses';
import { keepRunningAfterResponse } from '@/lib/api/after-response';
import { ForbiddenError } from '@/lib/api/errors';
import {
  BACKGROUND_TASK_NAMES,
  runMaintenanceTick,
  __test_setTickRunning as sharedTestSetTickRunning,
} from '@/lib/orchestration/maintenance/run-tick';

/**
 * The whole invocation's budget: the awaited schedules sweep, then the
 * background chain under `after()`. 300 s is the Vercel Fluid compute default
 * and the Hobby plan's ceiling, so it deploys on every plan. It is **not** the
 * watchdog's budget: the watchdog (`BACKGROUND_TASK_MAX_MS` in `run-tick.ts`)
 * gives the sweep and the chain five minutes each, so a slow sweep leaves the
 * chain less than the watchdog allows. A Pro host with many orgs can raise this
 * to 800.
 */
export const maxDuration = 300;

/** Exposed for testing only — simulate an in-progress tick. */
export const __test_setTickRunning = sharedTestSetTickRunning;

async function tick(request: NextRequest): Promise<Response> {
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

  if (result.background) {
    keepRunningAfterResponse(result.background, 'Maintenance tick: background chain');
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
}

export const POST = withAdminAuth(tick);

export const GET = withAdminAuth((request, session: AuthenticatedSession) => {
  if (!isApiKeySession(session)) {
    throw new ForbiddenError('GET accepts an admin API key only; use POST from a browser session');
  }
  return tick(request);
});

export function HEAD(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
}
