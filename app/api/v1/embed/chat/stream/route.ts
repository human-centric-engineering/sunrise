/**
 * Embeddable Chat Widget — Streaming (SSE)
 *
 * POST /api/v1/embed/chat/stream
 *
 * Authenticates via `X-Embed-Token` header (not session).
 * Sets CORS headers dynamically from the token's `allowedOrigins`.
 * Reuses `streamChat()` from the orchestration chat handler.
 *
 * Authentication: Embed token (no session required).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sseResponse } from '@/lib/api/sse';
import { getClientIP } from '@/lib/security/ip';
import { embedChatLimiter, createRateLimitResponse, imageLimiter } from '@/lib/security/rate-limit';
import { resolveEmbedToken, isOriginAllowed } from '@/lib/embed/auth';
import { streamChat } from '@/lib/orchestration/chat';
import { logger } from '@/lib/logging';
import { cuidSchema } from '@/lib/validations/common';
import { chatAttachmentsArraySchema } from '@/lib/validations/orchestration';
import { validateImageMagicBytes, validatePdfMagicBytes } from '@/lib/storage/image';

const embedChatSchema = z.object({
  // Allow empty message when attachments are present — vision turns
  // commonly send a single photo with no text body. Server-side gate
  // continues to require non-empty input when both are empty.
  message: z.string().max(10_000),
  conversationId: cuidSchema.optional(),
  attachments: chatAttachmentsArraySchema.optional(),
});

function corsHeaders(origin: string | null, allowedOrigins: string[]): Record<string, string> {
  const effectiveOrigin =
    allowedOrigins.length === 0 ? '*' : origin && allowedOrigins.includes(origin) ? origin : '';

  if (!effectiveOrigin) return {};

  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Embed-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  const token = request.headers.get('x-embed-token');
  if (!token) {
    return new NextResponse(null, { status: 204, headers: corsHeaders(null, []) });
  }

  const clientIp = getClientIP(request);
  const ctx = await resolveEmbedToken(token, clientIp);
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin, ctx?.allowedOrigins ?? []);

  return new NextResponse(null, { status: 204, headers });
}

export async function POST(request: NextRequest): Promise<Response> {
  const origin = request.headers.get('origin');
  const token = request.headers.get('x-embed-token');

  if (!token) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'MISSING_TOKEN', message: 'X-Embed-Token header required' },
      },
      { status: 401 }
    );
  }

  const clientIp = getClientIP(request);

  // Rate limit per token + IP
  const rateKey = `${token}:${clientIp}`;
  const rateLimit = embedChatLimiter.check(rateKey);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const ctx = await resolveEmbedToken(token, clientIp);
  if (!ctx) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Invalid or inactive embed token' },
      },
      { status: 401 }
    );
  }

  // CORS origin check
  if (!isOriginAllowed(origin, ctx.allowedOrigins)) {
    return NextResponse.json(
      { success: false, error: { code: 'ORIGIN_DENIED', message: 'Origin not allowed' } },
      { status: 403 }
    );
  }

  // Parse body
  let body: z.infer<typeof embedChatSchema>;
  try {
    const raw: unknown = await request.json();
    body = embedChatSchema.parse(raw);
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request body' } },
      { status: 400 }
    );
  }

  // Require either text or at least one attachment — a turn with
  // neither is an empty submit and gets rejected at the boundary.
  if (!body.message.trim() && (!body.attachments || body.attachments.length === 0)) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Message or attachment required' },
      },
      { status: 400 }
    );
  }

  // Attachment-bearing turns get the same rate-limit bucket + magic-
  // byte validation as the admin / consumer routes. Per-agent / global
  // / capability gates run inside `streamChat`.
  const corsResponseHeaders = corsHeaders(origin, ctx.allowedOrigins);
  if (body.attachments && body.attachments.length > 0) {
    const attachmentLimit = imageLimiter.check(`image:embed:${token}:${clientIp}`);
    if (!attachmentLimit.success) return createRateLimitResponse(attachmentLimit);

    for (const attachment of body.attachments) {
      if (attachment.mediaType.startsWith('image/')) {
        const buffer = Buffer.from(attachment.data, 'base64');
        const validation = validateImageMagicBytes(buffer);
        if (!validation.valid || validation.detectedType !== attachment.mediaType) {
          logger.warn('Embed image attachment magic-byte validation failed', {
            agentSlug: ctx.agentSlug,
            declaredMediaType: attachment.mediaType,
            detectedMediaType: validation.detectedType,
            error: validation.error,
          });
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'IMAGE_INVALID_TYPE',
                message:
                  'Attachment is not a valid image file. Magic bytes do not match the declared MIME type.',
              },
            },
            { status: 415, headers: corsResponseHeaders }
          );
        }
      } else if (attachment.mediaType === 'application/pdf') {
        const buffer = Buffer.from(attachment.data, 'base64');
        if (!validatePdfMagicBytes(buffer)) {
          logger.warn('Embed PDF attachment magic-byte validation failed', {
            agentSlug: ctx.agentSlug,
          });
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'IMAGE_INVALID_TYPE',
                message: 'Attachment is not a valid PDF file. The %PDF- header is missing.',
              },
            },
            { status: 415, headers: corsResponseHeaders }
          );
        }
      }
    }
  }

  logger.info('Embed chat stream started', {
    agentSlug: ctx.agentSlug,
    userId: ctx.userId,
    conversationId: body.conversationId,
    attachmentCount: body.attachments?.length ?? 0,
  });

  const events = streamChat({
    message: body.message,
    agentSlug: ctx.agentSlug,
    userId: ctx.userId,
    conversationId: body.conversationId,
    attachments: body.attachments,
    signal: request.signal,
  });

  return sseResponse(events, { signal: request.signal, headers: corsResponseHeaders });
}
