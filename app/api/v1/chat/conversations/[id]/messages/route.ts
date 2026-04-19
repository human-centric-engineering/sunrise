/**
 * Consumer Chat — Conversation messages
 *
 * GET /api/v1/chat/conversations/:id/messages
 *
 * Returns messages for a conversation, scoped to the caller and
 * publicly visible agents. Returns 404 for missing or unauthorized
 * conversations.
 *
 * Authentication: Any authenticated user.
 */

import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const conversation = await prisma.aiConversation.findFirst({
    where: {
      id,
      userId: session.user.id,
      agent: { visibility: { in: ['public', 'invite_only'] }, isActive: true },
    },
  });
  if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

  const messages = await prisma.aiMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      content: true,
      createdAt: true,
    },
  });

  log.info('Consumer conversation messages fetched', {
    conversationId: id,
    count: messages.length,
  });
  return successResponse({ messages });
});
