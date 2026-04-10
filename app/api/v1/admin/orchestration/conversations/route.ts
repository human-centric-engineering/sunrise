/**
 * Admin Orchestration — Conversations list
 *
 * GET /api/v1/admin/orchestration/conversations
 *
 * Returns only the caller's own conversations. Admins using these
 * endpoints are still scoped to `session.user.id`; a cross-user audit
 * view is out of scope for this session (would be a separate endpoint
 * with its own auth model).
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { listConversationsQuerySchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, agentId, isActive, q } = validateQueryParams(
    searchParams,
    listConversationsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiConversationWhereInput = {
    userId: session.user.id,
  };
  if (agentId) where.agentId = agentId;
  if (isActive !== undefined) where.isActive = isActive;
  if (q) where.title = { contains: q, mode: 'insensitive' };

  const [conversations, total] = await Promise.all([
    prisma.aiConversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      include: { _count: { select: { messages: true } } },
    }),
    prisma.aiConversation.count({ where }),
  ]);

  log.info('Conversations listed', { count: conversations.length, total });

  return paginatedResponse(conversations, { page, limit, total });
});
