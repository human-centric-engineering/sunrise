/**
 * Unified Maintenance Tick
 *
 * POST /api/v1/admin/orchestration/maintenance/tick
 *
 * Runs all periodic maintenance tasks in one call:
 * 1. processDueSchedules() — workflow cron schedules
 * 2. processPendingRetries() — webhook delivery retry queue
 * 3. reapZombieExecutions() — mark stale running executions as failed
 * 4. backfillMissingEmbeddings() — re-embed messages that failed embedding
 * 5. enforceRetentionPolicies() — delete conversations past retention window
 *
 * Designed to be called every ~60s by an external cron job.
 * Auth: Admin role required (session or API key with admin scope).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logger } from '@/lib/logging';
import { processDueSchedules } from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';

export const POST = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const startMs = Date.now();

  const [schedules, retries, reaper, embeddings, retention] = await Promise.allSettled([
    processDueSchedules(),
    processPendingRetries(),
    reapZombieExecutions(),
    backfillMissingEmbeddings(),
    enforceRetentionPolicies(),
  ]);

  function unwrap<T>(r: PromiseSettledResult<T>): T | { error: string } {
    return r.status === 'fulfilled' ? r.value : { error: String(r.reason) };
  }

  const results = {
    schedules: unwrap(schedules),
    webhookRetries: unwrap(retries),
    zombieReaper: unwrap(reaper),
    embeddingBackfill: unwrap(embeddings),
    retention: unwrap(retention),
    durationMs: Date.now() - startMs,
  };

  logger.info('Maintenance tick completed', results);

  return successResponse(results);
});
