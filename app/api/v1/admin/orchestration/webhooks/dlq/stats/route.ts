/**
 * Webhook Dead Letter Queue — Stats
 *
 * GET /api/v1/admin/orchestration/webhooks/dlq/stats
 *
 * Lightweight depth signal for the health dashboard (#41 pairs with
 * this endpoint). Returns the number of exhausted deliveries in the
 * last 24h, the total exhausted across the admin's subscriptions, and
 * the timestamp of the oldest exhausted row.
 *
 * Always scoped to the calling admin's subscriptions.
 *
 * Authentication: Admin only.
 */

import type { NextRequest } from 'next/server';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

export const GET = withAdminAuth(async (request: NextRequest, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const scope = {
    status: 'exhausted' as const,
    subscription: { createdBy: session.user.id },
  };
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [exhausted24h, exhaustedTotal, oldest] = await Promise.all([
    prisma.aiWebhookDelivery.count({
      where: { ...scope, createdAt: { gte: since24h } },
    }),
    prisma.aiWebhookDelivery.count({ where: scope }),
    prisma.aiWebhookDelivery.findFirst({
      where: scope,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  return successResponse({
    exhausted24h,
    exhaustedTotal,
    oldestExhaustedAt: oldest?.createdAt.toISOString() ?? null,
  });
});
