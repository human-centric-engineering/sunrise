/**
 * Admin Orchestration — Clear conversations
 *
 * POST /api/v1/admin/orchestration/conversations/clear
 *
 * Bulk delete the caller's own conversations matching the supplied
 * filters. At least one filter is REQUIRED (`olderThan` or `agentId`)
 * — an empty body is rejected by the Zod schema to prevent accidental
 * "delete all my conversations" calls.
 *
 * `AiMessage` rows cascade via the foreign key relation. The `userId`
 * scope is hardcoded to `session.user.id` — admins cannot clear other
 * users' conversations through this endpoint.
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
import { clearConversationsBodySchema } from '@/lib/validations/orchestration';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, clearConversationsBodySchema);

  const where: Prisma.AiConversationWhereInput = {
    userId: session.user.id,
  };
  if (body.agentId) where.agentId = body.agentId;
  if (body.olderThan) where.createdAt = { lt: new Date(body.olderThan) };

  const result = await prisma.aiConversation.deleteMany({ where });

  log.info('Conversations cleared', {
    userId: session.user.id,
    deletedCount: result.count,
    agentId: body.agentId,
    olderThan: body.olderThan,
  });

  return successResponse({ deletedCount: result.count });
});
