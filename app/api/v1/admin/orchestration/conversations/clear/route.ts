/**
 * Admin Orchestration — Clear conversations
 *
 * POST /api/v1/admin/orchestration/conversations/clear
 *
 * Bulk delete conversations matching the supplied filters. At least
 * one of `olderThan` or `agentId` is REQUIRED — an empty body is
 * rejected by the Zod schema to prevent accidental "delete everything"
 * calls.
 *
 * Scope:
 *   - default: caller's own conversations (`session.user.id`)
 *   - `userId`: a specific other user's conversations
 *   - `allUsers: true`: across all users (still narrowed by the
 *     `olderThan` / `agentId` filters)
 *
 * All deletions (including self-scoped) are recorded in the admin audit
 * log so there's an immutable trail. `AiMessage` rows cascade via the
 * foreign-key relation.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { clearConversationsBodySchema } from '@/lib/validations/orchestration';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, clearConversationsBodySchema);

  const scope: 'self' | 'user' | 'all' = body.allUsers ? 'all' : body.userId ? 'user' : 'self';

  const where: Prisma.AiConversationWhereInput = {};
  if (scope === 'self') where.userId = session.user.id;
  else if (scope === 'user') where.userId = body.userId!;
  if (body.agentId) where.agentId = body.agentId;
  if (body.olderThan) where.createdAt = { lt: new Date(body.olderThan) };

  const result = await prisma.aiConversation.deleteMany({ where });

  log.info('Conversations cleared', {
    scope,
    callerId: session.user.id,
    targetUserId: scope === 'user' ? body.userId : undefined,
    deletedCount: result.count,
    agentId: body.agentId,
    olderThan: body.olderThan,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'conversation.bulk_clear',
    entityType: 'conversation',
    metadata: {
      scope,
      targetUserId: scope === 'user' ? body.userId : null,
      agentId: body.agentId ?? null,
      olderThan: body.olderThan ?? null,
      deletedCount: result.count,
    },
    clientIp: clientIP,
  });

  return successResponse({ deletedCount: result.count });
});
