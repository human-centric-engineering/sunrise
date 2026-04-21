/**
 * Admin Orchestration — Observability dashboard stats
 *
 * GET /api/v1/admin/orchestration/observability/dashboard-stats
 *
 * Returns aggregated stats for the observability dashboard:
 *   - Active conversations (caller-scoped)
 *   - Today's request count (from AiCostLog)
 *   - 24h error rate (failed / total executions)
 *   - Last 5 failed executions
 *   - Top 10 capabilities by invocation count
 *
 * All queries run in a single Promise.all batch.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { computeETag, checkConditional } from '@/lib/api/etag';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

export const GET = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    activeConversations,
    todayRequests,
    totalExecutions24h,
    failedExecutions24h,
    recentErrors,
    topCapabilities,
  ] = await Promise.all([
    // Active conversations for this user
    prisma.aiConversation.count({
      where: { userId: session.user.id, isActive: true },
    }),

    // Today's request count (cost log entries)
    prisma.aiCostLog.count({
      where: { createdAt: { gte: todayStart } },
    }),

    // Total executions in last 24h
    prisma.aiWorkflowExecution.count({
      where: { userId: session.user.id, createdAt: { gte: twentyFourHoursAgo } },
    }),

    // Failed executions in last 24h
    prisma.aiWorkflowExecution.count({
      where: {
        userId: session.user.id,
        status: 'failed',
        createdAt: { gte: twentyFourHoursAgo },
      },
    }),

    // Last 5 failed executions
    prisma.aiWorkflowExecution.findMany({
      where: { userId: session.user.id, status: 'failed' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        errorMessage: true,
        workflowId: true,
        createdAt: true,
      },
    }),

    // Top 10 capabilities by invocation count (tool-role messages with a capabilitySlug)
    prisma.aiMessage.groupBy({
      by: ['capabilitySlug'],
      where: {
        capabilitySlug: { not: null },
        conversation: { userId: session.user.id },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
  ]);

  const errorRate = totalExecutions24h === 0 ? 0 : failedExecutions24h / totalExecutions24h;

  const data = {
    activeConversations,
    todayRequests,
    errorRate,
    recentErrors,
    topCapabilities: topCapabilities.map((row) => ({
      slug: row.capabilitySlug as string,
      count: row._count.id,
    })),
  };

  const etag = computeETag(data);
  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Observability dashboard stats fetched', {
    activeConversations,
    todayRequests,
    errorRate,
  });

  return successResponse(data, undefined, { headers: { ETag: etag } });
});
