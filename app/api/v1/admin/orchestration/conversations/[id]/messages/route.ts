/**
 * Admin Orchestration — Conversation messages
 *
 * GET /api/v1/admin/orchestration/conversations/:id/messages
 *
 * Returns messages for any conversation (cross-user admin audit).
 * Includes full metadata (token counts, cost, latency) that the
 * consumer endpoint strips.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const conversation = await prisma.aiConversation.findUnique({
    where: { id },
    select: { id: true, userId: true, agentId: true },
  });
  if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

  const messages = await prisma.aiMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
  });

  log.info('Admin conversation messages fetched', {
    conversationId: id,
    count: messages.length,
    userId: conversation.userId,
  });
  return successResponse({
    conversation: {
      id: conversation.id,
      userId: conversation.userId,
      agentId: conversation.agentId,
    },
    messages,
  });
});
