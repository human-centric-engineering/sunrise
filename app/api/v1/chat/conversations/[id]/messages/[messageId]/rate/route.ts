/**
 * Consumer Chat — Rate a message (thumbs up/down)
 *
 * POST /api/v1/chat/conversations/:id/messages/:messageId/rate
 *
 * Allows end-users to submit feedback on assistant messages.
 * Only assistant messages in the user's own conversations can be rated.
 *
 * Body: { rating: 1 | -1 }  (1 = thumbs up, -1 = thumbs down)
 *
 * Authentication: Any authenticated user (not admin-only).
 */

import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { rateMessageSchema } from '@/lib/validations/orchestration';

type Params = { id: string; messageId: string };

export const POST = withAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawConvId, messageId: rawMsgId } = await params;

  const convId = cuidSchema.safeParse(rawConvId);
  if (!convId.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }

  const msgId = cuidSchema.safeParse(rawMsgId);
  if (!msgId.success) {
    throw new ValidationError('Invalid message id', { messageId: ['Must be a valid CUID'] });
  }

  const body = await validateRequestBody(request, rateMessageSchema);

  // Verify the conversation belongs to this user and the agent is publicly visible
  const conversation = await prisma.aiConversation.findFirst({
    where: {
      id: convId.data,
      userId: session.user.id,
      agent: { visibility: { in: ['public', 'invite_only'] }, isActive: true },
    },
  });
  if (!conversation) throw new NotFoundError('Conversation not found');

  // Verify the message exists, belongs to this conversation, and is an assistant message
  const message = await prisma.aiMessage.findFirst({
    where: {
      id: msgId.data,
      conversationId: convId.data,
      role: 'assistant',
    },
  });
  if (!message) throw new NotFoundError('Message not found');

  const updated = await prisma.aiMessage.update({
    where: { id: message.id },
    data: {
      rating: body.rating,
      ratedAt: new Date(),
    },
    select: {
      id: true,
      rating: true,
      ratedAt: true,
    },
  });

  return successResponse({ message: updated });
});
