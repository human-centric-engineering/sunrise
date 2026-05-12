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
import { errorResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import {
  apiLimiter,
  consumerChatLimiter,
  agentChatLimiter,
  createRateLimitResponse,
  imageLimiter,
} from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { streamChat } from '@/lib/orchestration/chat';
import { consumerChatRequestSchema } from '@/lib/validations/orchestration';
import { getRequestId } from '@/lib/logging/context';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ForbiddenError } from '@/lib/api/errors';
import { validateImageMagicBytes, validatePdfMagicBytes } from '@/lib/storage/image';

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

  // Attachment-bearing turns get an extra rate-limit bucket + magic-
  // byte validation before reaching the orchestration handler. Per-
  // agent / global / capability gates run inside `streamChat`. The
  // consumer rate limit is keyed by `image:user:` so it shares the
  // bucket with the admin route — a single user cannot abuse images
  // by switching surfaces.
  if (body.attachments && body.attachments.length > 0) {
    const attachmentLimit = imageLimiter.check(`image:user:${session.user.id}`);
    if (!attachmentLimit.success) return createRateLimitResponse(attachmentLimit);

    for (const attachment of body.attachments) {
      if (attachment.mediaType.startsWith('image/')) {
        const buffer = Buffer.from(attachment.data, 'base64');
        const validation = validateImageMagicBytes(buffer);
        // Two failure modes: (a) magic bytes don't match any known
        // image, or (b) magic bytes match a different format than the
        // declared MIME (e.g. JPEG body labelled as image/png). Both
        // produce 415 — the user-facing distinction isn't useful, but
        // logging the detected type makes the audit trail clearer.
        if (!validation.valid || validation.detectedType !== attachment.mediaType) {
          log.warn('Image attachment magic-byte validation failed', {
            agentSlug: body.agentSlug,
            declaredMediaType: attachment.mediaType,
            detectedMediaType: validation.detectedType,
            error: validation.error,
            userId: session.user.id,
          });
          return errorResponse(
            'Attachment is not a valid image file. Magic bytes do not match the declared MIME type.',
            { code: 'IMAGE_INVALID_TYPE', status: 415 }
          );
        }
      } else if (attachment.mediaType === 'application/pdf') {
        const buffer = Buffer.from(attachment.data, 'base64');
        if (!validatePdfMagicBytes(buffer)) {
          log.warn('PDF attachment magic-byte validation failed', {
            agentSlug: body.agentSlug,
            userId: session.user.id,
          });
          return errorResponse('Attachment is not a valid PDF file. The %PDF- header is missing.', {
            code: 'IMAGE_INVALID_TYPE',
            status: 415,
          });
        }
      }
    }
  }

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

    // Atomic increment: only succeeds if use_count < max_uses (or max_uses
    // is NULL, i.e. unlimited). Prevents TOCTOU race where concurrent
    // requests both pass the check above and double-increment past the cap.
    const incrementResult: number = await prisma.$executeRaw`
      UPDATE ai_agent_invite_token
      SET use_count = use_count + 1
      WHERE id = ${token.id}
        AND (max_uses IS NULL OR use_count < max_uses)
    `;
    if (incrementResult === 0) {
      throw new ForbiddenError('Invite token has reached its usage limit');
    }
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
    attachments: body.attachments,
    requestId,
    signal: request.signal,
  });

  return sseResponse(events, { signal: request.signal });
});
