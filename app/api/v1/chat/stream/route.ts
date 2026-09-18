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
  consumerChatLimiter,
  agentChatLimiter,
  createRateLimitResponse,
  imageLimiter,
} from '@/lib/security/rate-limit';
import { streamChat } from '@/lib/orchestration/chat';
import {
  consumeInviteToken,
  resolveInviteToken,
  type InviteTokenRefusal,
} from '@/lib/orchestration/invite-tokens';
import { consumerChatRequestSchema } from '@/lib/validations/orchestration';
import { getRequestId, getVisitorId } from '@/lib/logging/context';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ForbiddenError } from '@/lib/api/errors';
import { validateImageMagicBytes, validatePdfMagicBytes } from '@/lib/storage/image';

/**
 * What the caller is told for each refusal. `not-found` and `wrong-org` share
 * a sentence on purpose: a token minted in another org must read exactly
 * like one that was never minted.
 */
const INVITE_REFUSALS: Record<InviteTokenRefusal, string> = {
  'not-found': 'Invalid or revoked invite token',
  'wrong-org': 'Invalid or revoked invite token',
  revoked: 'Invalid or revoked invite token',
  expired: 'Invite token has expired',
  exhausted: 'Invite token has reached its usage limit',
};

export const POST = withAuth(
  async (request, session) => {
    const userLimit = consumerChatLimiter.check(session.user.id);
    if (!userLimit.success) return createRateLimitResponse(userLimit);

    const log = await getRouteLogger(request);
    const body = await validateRequestBody(request, consumerChatRequestSchema);
    const requestId = await getRequestId();
    const visitorId = await getVisitorId();

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
            return errorResponse(
              'Attachment is not a valid PDF file. The %PDF- header is missing.',
              {
                code: 'IMAGE_INVALID_TYPE',
                status: 415,
              }
            );
          }
        }
      }
    }

    // For invite_only agents, verify the invite token
    if (agent.visibility === 'invite_only') {
      if (!body.inviteToken) {
        throw new ForbiddenError('This agent requires an invite token');
      }

      // One implementation for both routes (`lib/orchestration/invite-tokens.ts`);
      // the refusal messages are this route's. A token from another org reads
      // as invalid — the same words as a token that does not exist.
      const outcome = await resolveInviteToken(agent.id, body.inviteToken);
      if (!outcome.ok) {
        throw new ForbiddenError(INVITE_REFUSALS[outcome.reason]);
      }

      // Atomic: the increment succeeds only while use_count < max_uses, so
      // concurrent requests that both passed the read cannot double-spend
      // past the cap.
      if (!(await consumeInviteToken(outcome.token.id))) {
        throw new ForbiddenError(INVITE_REFUSALS.exhausted);
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
      // Opaque scope carrier — validated + bounded by the request schema, then
      // threaded verbatim into every capability dispatch. Inert in vanilla
      // Sunrise (no built-in reads it); a fork consuming it for access control
      // must re-validate against the user's entitlements (see schema SECURITY note).
      scope: body.scope,
      requestId,
      visitorId,
      signal: request.signal,
    });

    return sseResponse(events, { signal: request.signal });
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because:
        "Every conversation, message and cost row this writes or reads is keyed on the caller's own id.",
    },
  }
);
