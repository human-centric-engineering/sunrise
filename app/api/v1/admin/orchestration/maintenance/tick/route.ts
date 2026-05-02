/**
 * Unified Maintenance Tick
 *
 * POST /api/v1/admin/orchestration/maintenance/tick
 *
 * Runs all periodic maintenance tasks. The HTTP response returns once
 * `processDueSchedules()` has claimed and fired any due schedules; the
 * remaining six tasks run as a background chain inside the same overlap
 * guard and log their results when they settle.
 *
 *   1. processDueSchedules()         — workflow cron schedules            (awaited)
 *   2. processPendingRetries()       — webhook delivery retry queue       (background)
 *   3. processPendingHookRetries()   — event-hook delivery retry queue    (background)
 *   4. reapZombieExecutions()        — mark stale running execs as failed (background)
 *   5. backfillMissingEmbeddings()   — re-embed messages that failed      (background)
 *   6. enforceRetentionPolicies()    — delete past retention window       (background)
 *   7. processPendingExecutions()    — recover orphaned pending workflows (background)
 *
 * Designed to be called every ~60s by an external cron job. The 202
 * response decouples HTTP duration from retention/reaper runtime so a
 * cron caller with a short timeout never cuts off mid-task. Engine work
 * inside `processDueSchedules` was already detached via `void drainEngine`,
 * so HTTP duration is bounded by DB-claim work only.
 *
 * Auth: Admin role required (session or API key with admin scope).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logger } from '@/lib/logging';
import { processDueSchedules, processPendingExecutions } from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
import { processPendingHookRetries } from '@/lib/orchestration/hooks/registry';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';

/** Module-level guard against overlapping tick executions. */
let tickRunning = false;

/**
 * Per-tick monotonic token. Each accepted tick claims a fresh token and
 * tags its background chain + watchdog with it. Only the owning token can
 * release `tickRunning` — this prevents a late-settling old chain (whose
 * watchdog already force-released the guard) from accidentally releasing
 * a newer tick's guard.
 */
let currentTickToken = 0;

/** Exposed for testing only — simulate an in-progress tick. */
export function __test_setTickRunning(value: boolean): void {
  tickRunning = value;
}

const BACKGROUND_TASK_NAMES = [
  'webhookRetries',
  'hookRetries',
  'zombieReaper',
  'embeddingBackfill',
  'retention',
  'pendingExecutionRecovery',
] as const;

/**
 * Watchdog timeout for the background chain. If the chain hasn't settled
 * within this window we force-release the guard so subsequent ticks can
 * proceed. Five minutes is a generous upper bound — any single maintenance
 * task taking longer than this represents a real incident worth flagging
 * via the warning log line.
 */
const BACKGROUND_TASK_MAX_MS = 5 * 60 * 1000;

export const POST = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  if (tickRunning) {
    logger.info('Maintenance tick skipped — previous tick still running');
    return successResponse({ skipped: true, reason: 'previous tick still running' });
  }

  tickRunning = true;
  const myTickToken = ++currentTickToken;
  const startMs = Date.now();

  let schedules: Awaited<ReturnType<typeof processDueSchedules>> | { error: string };
  try {
    schedules = await processDueSchedules();
  } catch (err) {
    schedules = { error: err instanceof Error ? err.message : String(err) };
  }

  // Watchdog: force-release the guard if the background chain hangs past
  // the max duration. Token-checked so we only release if this tick still
  // owns the guard.
  const watchdogId = setTimeout(() => {
    if (currentTickToken !== myTickToken || !tickRunning) return;
    logger.warn('Maintenance tick: background chain exceeded max duration; releasing guard', {
      maxDurationMs: BACKGROUND_TASK_MAX_MS,
      tickStartMs: startMs,
    });
    tickRunning = false;
  }, BACKGROUND_TASK_MAX_MS);

  // Background chain: settles asynchronously, releases the overlap guard
  // when complete, and logs per-task results.
  void Promise.allSettled([
    processPendingRetries(),
    processPendingHookRetries(),
    reapZombieExecutions(),
    backfillMissingEmbeddings(),
    enforceRetentionPolicies(),
    processPendingExecutions(),
  ])
    .then((settled) => {
      const summary = Object.fromEntries(
        BACKGROUND_TASK_NAMES.map((name, i) => {
          const result = settled[i];
          return [
            name,
            result.status === 'fulfilled' ? result.value : { error: String(result.reason) },
          ];
        })
      );
      logger.info('Maintenance tick background tasks completed', {
        ...summary,
        totalDurationMs: Date.now() - startMs,
      });
    })
    .finally(() => {
      clearTimeout(watchdogId);
      // Only release the guard if this tick still owns it. If the watchdog
      // already fired and a newer tick has taken over, leave the newer tick's
      // state alone.
      if (currentTickToken === myTickToken) {
        tickRunning = false;
      }
    });

  return successResponse(
    {
      schedules,
      backgroundTasks: BACKGROUND_TASK_NAMES,
      durationMs: Date.now() - startMs,
    },
    undefined,
    { status: 202 }
  );
});
