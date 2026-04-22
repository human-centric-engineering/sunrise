/**
 * Admin Orchestration — Conversations list
 *
 * GET /api/v1/admin/orchestration/conversations
 *
 * Returns the calling admin's own conversations, scoped to
 * `session.user.id`. Matches the scoping used by the detail,
 * PATCH, and DELETE endpoints. Supports filtering by agent,
 * date range, and text search. Any `userId` query parameter
 * is ignored — callers only ever see their own conversations.
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
  const { page, limit, agentId, isActive, q, messageSearch, tag, dateFrom, dateTo } =
    validateQueryParams(searchParams, listConversationsQuerySchema);
  const skip = (page - 1) * limit;

  const where: Prisma.AiConversationWhereInput = { userId: session.user.id };
  if (agentId) where.agentId = agentId;
  if (isActive !== undefined) where.isActive = isActive;
  if (q) where.title = { contains: q, mode: 'insensitive' };
  if (messageSearch) {
    where.messages = { some: { content: { contains: messageSearch, mode: 'insensitive' } } };
  }
  if (tag) {
    where.tags = { has: tag };
  }
  if (dateFrom || dateTo) {
    where.updatedAt = {
      ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
      ...(dateTo ? { lte: new Date(dateTo) } : {}),
    };
  }

  const [conversations, total] = await Promise.all([
    prisma.aiConversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.aiConversation.count({ where }),
  ]);

  log.info('Conversations listed', { count: conversations.length, total });

  return paginatedResponse(conversations, { page, limit, total });
});
