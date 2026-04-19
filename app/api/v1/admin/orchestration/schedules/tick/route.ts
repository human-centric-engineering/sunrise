/**
 * Admin Orchestration — Scheduler Tick
 *
 * POST /api/v1/admin/orchestration/schedules/tick
 *
 * Processes all due workflow schedules. Designed to be called every
 * ~60 seconds by an external cron job (e.g. Vercel Cron, Railway Cron,
 * or a simple `curl` from system crontab).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { processDueSchedules } from '@/lib/orchestration/scheduling';

export const POST = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const result = await processDueSchedules();

  return successResponse({ ...result });
});
