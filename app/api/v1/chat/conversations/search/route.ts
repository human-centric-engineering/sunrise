/**
 * Consumer Chat — Conversation Search
 *
 * GET /api/v1/chat/conversations/search?q=term
 *
 * Searches the authenticated user's conversations by message content.
 * Only returns conversations with publicly visible (or invite_only) agents.
 *
 * Authentication: Any authenticated user.
 */

import type { Prisma } from '@prisma/client';
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { chatLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { consumerConversationSearchSchema } from '@/lib/validations/orchestration';

export const GET = withAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = chatLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { q, page, limit } = validateQueryParams(searchParams, consumerConversationSearchSchema);
  const skip = (page - 1) * limit;

  // Find conversations where any message matches the search term.
  // Query at the conversation level so Prisma handles skip/take correctly.
  const where: Prisma.AiConversationWhereInput = {
    userId: session.user.id,
    isActive: true,
    agent: { visibility: { in: ['public', 'invite_only'] }, isActive: true },
    messages: { some: { content: { contains: q, mode: 'insensitive' } } },
  };

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

  log.info('Consumer conversation search', {
    query: q,
    results: conversations.length,
    total,
    userId: session.user.id,
  });

  return paginatedResponse(conversations, { page, limit, total });
});
