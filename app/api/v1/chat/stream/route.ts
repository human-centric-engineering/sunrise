/**
 * Consumer Chat — Streaming (SSE)
 *
 * POST /api/v1/chat/stream
 *
 * Public-facing chat endpoint for authenticated end-users (non-admin).
 * Agents with `visibility = 'public'` or `'invite_only'` (with valid
 * token) are accessible. Uses the same `StreamingChatHandler` as the
 * admin endpoint but with:
 *   - `withAuth` instead of `withAdminAuth`
 *   - Stricter rate limits (consumerChatLimiter)
 *   - No contextType / contextId / entityContext (admin-only concepts)
 *   - Agent visibility + invite token enforcement
 *
 * Authentication: Any authenticated user.
 */

import { withAuth } from '@/lib/auth/guards';
import { sseResponse } from '@/lib/api/sse';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import {
  apiLimiter,
  consumerChatLimiter,
  agentChatLimiter,
  createRateLimitResponse,
} from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { streamChat } from '@/lib/orchestration/chat';
import { consumerChatRequestSchema } from '@/lib/validations/orchestration';
import { getRequestId } from '@/lib/logging/context';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ForbiddenError } from '@/lib/api/errors';

export const POST = withAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const ipLimit = apiLimiter.check(clientIP);
  if (!ipLimit.success) return createRateLimitResponse(ipLimit);

  const userLimit = consumerChatLimiter.check(session.user.id);
  if (!userLimit.success) return createRateLimitResponse(userLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, consumerChatRequestSchema);
  const requestId = await getRequestId();

  // Verify the agent exists and is active
  const agent = await prisma.aiAgent.findFirst({
    where: {
      slug: body.agentSlug,
      isActive: true,
      visibility: { in: ['public', 'invite_only'] },
    },
    select: { id: true, slug: true, visibility: true, rateLimitRpm: true },
  });

  if (!agent) {
    throw new NotFoundError(`Agent "${body.agentSlug}" not found`);
  }

  // Per-agent rate limit (overrides global default when configured)
  const agentLimit = agentChatLimiter.check(`${agent.id}:${session.user.id}`, agent.rateLimitRpm);
  if (!agentLimit.success) return createRateLimitResponse(agentLimit);

  // For invite_only agents, verify the invite token
  if (agent.visibility === 'invite_only') {
    if (!body.inviteToken) {
      throw new ForbiddenError('This agent requires an invite token');
    }

    const token = await prisma.aiAgentInviteToken.findFirst({
      where: {
        agentId: agent.id,
        token: body.inviteToken,
        revokedAt: null,
      },
    });

    if (!token) {
      throw new ForbiddenError('Invalid or revoked invite token');
    }

    if (token.expiresAt && token.expiresAt < new Date()) {
      throw new ForbiddenError('Invite token has expired');
    }

    if (token.maxUses !== null && token.useCount >= token.maxUses) {
      throw new ForbiddenError('Invite token has reached its usage limit');
    }

    // Increment use count
    await prisma.aiAgentInviteToken.update({
      where: { id: token.id },
      data: { useCount: { increment: 1 } },
    });
  }

  log.info('Consumer chat stream started', {
    agentSlug: body.agentSlug,
    conversationId: body.conversationId,
    userId: session.user.id,
  });

  const events = streamChat({
    message: body.message,
    agentSlug: body.agentSlug,
    userId: session.user.id,
    conversationId: body.conversationId,
    requestId,
    signal: request.signal,
  });

  return sseResponse(events, { signal: request.signal });
});
