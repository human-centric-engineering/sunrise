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
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, chatLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { streamChat } from '@/lib/orchestration/chat';
import { chatStreamRequestSchema } from '@/lib/validations/orchestration';
import { getRequestId } from '@/lib/logging/context';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const ipLimit = adminLimiter.check(clientIP);
  if (!ipLimit.success) return createRateLimitResponse(ipLimit);

  const userLimit = chatLimiter.check(session.user.id);
  if (!userLimit.success) return createRateLimitResponse(userLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, chatStreamRequestSchema);
  const requestId = await getRequestId();

  log.info('Chat stream started', {
    agentSlug: body.agentSlug,
    conversationId: body.conversationId,
    userId: session.user.id,
  });

  const events = streamChat({
    message: body.message,
    agentSlug: body.agentSlug,
    userId: session.user.id,
    conversationId: body.conversationId,
    contextType: body.contextType,
    contextId: body.contextId,
    entityContext: body.entityContext,
    requestId,
    signal: request.signal,
  });

  return sseResponse(events, { signal: request.signal });
});
