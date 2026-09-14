/**
 * Admin Orchestration — Observability dashboard stats
 *
 * GET /api/v1/admin/orchestration/observability/dashboard-stats
 *
 * Returns aggregated stats for the observability dashboard:
 *   - Active conversations (caller's own + system-owned)
 *   - Today's request count (from AiCostLog — deployment-wide)
 *   - 24h error rate (failed / total executions)
 *   - Last 5 failed executions
 *   - Top 10 capabilities by invocation count
 *
 * Everything except the cost-log count is scoped to what the caller can
 * see: their own rows, plus system-owned ones where the authorization policy
 * permits an unattributed read. See `executionVisibilityWhere` in
 * `lib/orchestration/access/execution-access.ts`.
 *
 * All queries run in a single Promise.all batch.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { computeETag, checkConditional } from '@/lib/api/etag';
import { executionVisibilityWhere } from '@/lib/orchestration/access/execution-access';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Same visibility as the executions list and the live-engine dashboard:
  // the caller's own runs plus system-owned ones (`userId = null` —
  // schedule- and inbound-triggered, #502), the latter as the policy answers
  // it. Scoping these counts to a bare `userId` match would hide exactly the
  // runs an operator most needs this page to surface, and would put this
  // dashboard and the live-engine one into open disagreement about the same
  // rows — which is also why the answer is read from the session rather than
  // asked for again here.
  const executionVisibility = executionVisibilityWhere(session);

  // Conversations use the owner-or-system arm only. A conversation shared
  // with this admin is still someone else's, so counting it as one of *their*
  // active conversations would overstate the number; an inbound thread has no
  // owner and belongs to the deployment, so it counts.
  const conversationVisibility: Prisma.AiConversationWhereInput = {
    OR: [{ userId: session.user.id }, { userId: null }],
  };

  const [
    activeConversations,
    todayRequests,
    totalExecutions24h,
    failedExecutions24h,
    recentErrors,
    topCapabilities,
  ] = await Promise.all([
    // Active conversations visible to this admin
    prisma.aiConversation.count({
      where: { AND: [conversationVisibility, { isActive: true }] },
    }),

    // Today's request count (cost log entries)
    prisma.aiCostLog.count({
      where: { createdAt: { gte: todayStart } },
    }),

    // Total executions in last 24h
    prisma.aiWorkflowExecution.count({
      where: { AND: [executionVisibility, { createdAt: { gte: twentyFourHoursAgo } }] },
    }),

    // Failed executions in last 24h
    prisma.aiWorkflowExecution.count({
      where: {
        AND: [executionVisibility, { status: 'failed', createdAt: { gte: twentyFourHoursAgo } }],
      },
    }),

    // Last 5 failed executions
    prisma.aiWorkflowExecution.findMany({
      where: { AND: [executionVisibility, { status: 'failed' }] },
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
        conversation: conversationVisibility,
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
