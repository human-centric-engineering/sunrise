/**
 * Consumer Chat — Conversations list
 *
 * GET /api/v1/chat/conversations
 *
 * Lists the authenticated user's own conversations. Only returns
 * conversations with publicly visible agents.
 *
 * Authentication: Any authenticated user.
 */

import type { Prisma } from '@prisma/client';
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { consumerConversationsQuerySchema } from '@/lib/validations/orchestration';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, agentSlug } = validateQueryParams(
    searchParams,
    consumerConversationsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiConversationWhereInput = {
    userId: session.user.id,
    agent: { visibility: { in: ['public', 'invite_only'] }, isActive: true },
  };
  if (agentSlug) where.agent = { ...(where.agent as object), slug: agentSlug };

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

  log.info('Consumer conversations listed', { count: conversations.length, total });

  return paginatedResponse(conversations, { page, limit, total });
});
