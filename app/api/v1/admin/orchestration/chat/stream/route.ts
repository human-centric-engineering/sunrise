/**
 * Admin Orchestration — Streaming Chat (SSE)
 *
 * POST /api/v1/admin/orchestration/chat/stream
 *
 * Pipes `StreamingChatHandler` output through the SSE bridge. The route
 * handler is deliberately thin: validate body, call `streamChat`, hand
 * the resulting AsyncIterable to `sseResponse`. All business logic lives
 * in `lib/orchestration/chat/`.
 *
 * The catch-all `internal_error` event in the handler emits a generic
 * sanitized message — see `streaming-handler.ts` for the rationale. The
 * SSE bridge adds a second defense-in-depth sanitization layer.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { sseResponse } from '@/lib/api/sse';
import { errorResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import {
  agentChatLimiter,
  chatLimiter,
  createRateLimitResponse,
  imageLimiter,
} from '@/lib/security/rate-limit';
import { streamChat } from '@/lib/orchestration/chat';
import { chatStreamRequestSchema } from '@/lib/validations/orchestration';
import { getRequestId, getVisitorId } from '@/lib/logging/context';
import { validateImageMagicBytes, validatePdfMagicBytes } from '@/lib/storage/image';

export const POST = withAdminAuth(async (request, session) => {
  const userLimit = chatLimiter.check(session.user.id);
  if (!userLimit.success) return createRateLimitResponse(userLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, chatStreamRequestSchema);
  const requestId = await getRequestId();
  const visitorId = await getVisitorId();

  // Per-agent rate limit (honours `agent.rateLimitRpm`). Mirrors the
  // consumer route so the field works the same way regardless of which
  // surface initiates the turn — the bucket key is `${agentId}:${userId}`
  // and is shared with the consumer limiter, so a user can't bypass
  // their per-agent throttle by switching surfaces. The lookup is a
  // single indexed find and is intentionally separate from the heavier
  // agent resolution inside `streamChat`.
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: body.agentSlug },
    select: { id: true, rateLimitRpm: true },
  });
  if (!agent) {
    return errorResponse(`Agent "${body.agentSlug}" not found`, {
      code: 'NOT_FOUND',
      status: 404,
    });
  }
  const agentLimit = agentChatLimiter.check(`${agent.id}:${session.user.id}`, agent.rateLimitRpm);
  if (!agentLimit.success) return createRateLimitResponse(agentLimit);

  // Attachment-bearing turns get an extra rate-limit bucket + magic-
  // byte validation before reaching the orchestration handler. Per-
  // agent / global / capability gates run inside `streamChat` because
  // they need the resolved agent + model. Magic-byte and rate-limit
  // failures return a regular HTTP error rather than an SSE event
  // because they short-circuit before streaming begins.
  if (body.attachments && body.attachments.length > 0) {
    const attachmentLimit = imageLimiter.check(`image:user:${session.user.id}`);
    if (!attachmentLimit.success) return createRateLimitResponse(attachmentLimit);

    for (const attachment of body.attachments) {
      if (attachment.mediaType.startsWith('image/')) {
        const buffer = Buffer.from(attachment.data, 'base64');
        const validation = validateImageMagicBytes(buffer);
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
      // Text MIMEs (text/plain, text/csv, text/markdown, .docx) don't
      // get magic-byte validation in v1 — Zod's MIME enum is the
      // boundary. Adding stronger validation is a Phase 5+ task.
    }
  }

  log.info('Chat stream started', {
    agentSlug: body.agentSlug,
    conversationId: body.conversationId,
    userId: session.user.id,
    attachmentCount: body.attachments?.length ?? 0,
  });

  const events = streamChat({
    message: body.message,
    agentSlug: body.agentSlug,
    userId: session.user.id,
    conversationId: body.conversationId,
    contextType: body.contextType,
    contextId: body.contextId,
    entityContext: body.entityContext,
    attachments: body.attachments,
    requestId,
    visitorId,
    signal: request.signal,
    // Admin route: clients opt in to inline trace annotations by setting
    // `includeTrace: true` (Learning Lab, agent test tab, evaluation
    // runner). Falsy/absent → no trace field, identical wire shape to
    // consumer chat — defence in depth so internal scores and args
    // cannot leak even if a non-admin route mistakenly imports this
    // module.
    includeTrace: body.includeTrace === true,
  });

  return sseResponse(events, { signal: request.signal });
});
