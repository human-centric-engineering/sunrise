/**
 * Admin Orchestration — Conversation messages
 *
 * GET /api/v1/admin/orchestration/conversations/:id/messages
 *
 * Returns messages for a conversation, scoped to the caller. Cross-user
 * access returns 404 — see the DELETE route for rationale.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  // Ownership check first — 404 if missing or owned by another user.
  const conversation = await prisma.aiConversation.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

  const messages = await prisma.aiMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
  });

  log.info('Conversation messages fetched', { conversationId: id, count: messages.length });
  return successResponse({ messages });
});
