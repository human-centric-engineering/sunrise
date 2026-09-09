/**
 * Consumer Chat — Single conversation (GET, DELETE)
 *
 * GET    /api/v1/chat/conversations/:id
 * DELETE /api/v1/chat/conversations/:id
 *
 * Scoped to the caller's own conversations with publicly visible agents.
 * Attempting to access another user's conversation returns 404 (not 403)
 * to avoid confirming the existence of resources owned by other users.
 *
 * Authentication: Any authenticated user.
 */

import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAuth<{ id: string }>(
  async (request, session, { params }) => {
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
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        _count: { select: { messages: true } },
      },
    });
    if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

    log.info('Consumer conversation fetched', { conversationId: id });
    return successResponse(conversation);
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because:
        "The conversation is fetched by `{ id, userId: session.user.id }`, so another user's id is a 404 rather than a read.",
    },
  }
);

export const DELETE = withAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success) {
      throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
    }
    const id = parsed.data;

    const existing = await prisma.aiConversation.findFirst({
      where: {
        id,
        userId: session.user.id,
        agent: { visibility: { in: ['public', 'invite_only'] }, isActive: true },
      },
    });
    if (!existing) throw new NotFoundError(`Conversation ${id} not found`);

    await prisma.aiConversation.delete({ where: { id } });

    log.info('Consumer conversation deleted', { conversationId: id, userId: session.user.id });
    return successResponse({ deleted: true });
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because: 'The delete is gated by the same `{ id, userId: session.user.id }` lookup.',
    },
  }
);
