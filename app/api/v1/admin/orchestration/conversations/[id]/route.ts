/**
 * Admin Orchestration — Single conversation (GET, DELETE)
 *
 * GET  /api/v1/admin/orchestration/conversations/:id
 * DELETE /api/v1/admin/orchestration/conversations/:id
 *
 * Scoped to the caller's own conversations. Attempting to access
 * another user's conversation returns 404 (not 403) — we never confirm
 * the existence of resources owned by other users.
 *
 * `AiMessage` rows cascade via the foreign key relation.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const conversation = await prisma.aiConversation.findFirst({
    where: { id, userId: session.user.id },
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      _count: { select: { messages: true } },
    },
  });
  if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

  log.info('Conversation fetched', { conversationId: id });
  return successResponse(conversation);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  // Ownership enforcement: 404 (not 403) if missing OR owned by another user.
  const existing = await prisma.aiConversation.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!existing) throw new NotFoundError(`Conversation ${id} not found`);

  await prisma.aiConversation.delete({ where: { id } });

  log.info('Conversation deleted', { conversationId: id, userId: session.user.id });
  return successResponse({ deleted: true });
});
