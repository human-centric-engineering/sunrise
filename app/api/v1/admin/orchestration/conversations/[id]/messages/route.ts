/**
 * Admin Orchestration — Conversation messages
 *
 * GET /api/v1/admin/orchestration/conversations/:id/messages
 *
 * Consent-gated: an admin can only fetch a conversation's messages if
 * they own the conversation OR the owner has created an active share
 * record (see `adminCanViewConversation` and the
 * `AiConversationShare` model). Cross-user reads without an active
 * share return 404 — the conversation's existence is not disclosed
 * (prevents user-enumeration).
 *
 * Returns full message metadata (token counts, cost, latency) that
 * the consumer endpoint strips.
 *
 * Audit: every cross-user (shared-basis) read writes an audit row via
 * `logConversationAccess` with `accessBasis: 'shared'` +
 * `conversationOwnerId`. Owner-basis reads skip logging by convention.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { adminCanViewConversation } from '@/lib/orchestration/access/conversation-access';
import { logConversationAccess } from '@/lib/orchestration/audit/admin-audit-logger';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const access = await adminCanViewConversation(id, session);
  if (!access.ok) throw new NotFoundError(`Conversation ${id} not found`);

  // We still need the agentId + title for the response payload + audit
  // entry. Fetch them now that authorization has passed.
  const conversation = await prisma.aiConversation.findUnique({
    where: { id },
    select: { id: true, userId: true, agentId: true, title: true },
  });
  // `access.ok` guaranteed it exists; the cast keeps TS happy without
  // a second throw path.
  if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

  const messages = await prisma.aiMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
  });

  log.info('Admin conversation messages fetched', {
    conversationId: id,
    count: messages.length,
    userId: conversation.userId,
    accessBasis: access.basis,
  });

  // Audit-of-audits for cross-user reads. Owner reads skip via the
  // helper's early-return on basis === 'owner'.
  logConversationAccess({
    adminUserId: session.user.id,
    conversationId: id,
    conversationTitle: conversation.title,
    conversationOwnerId: conversation.userId,
    accessBasis: access.basis ?? 'owner',
    action: 'conversation.messages_viewed',
    extra: { messageCount: messages.length },
    clientIp: getClientIP(request),
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
