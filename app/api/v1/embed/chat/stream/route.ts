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
import { embedChatLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { resolveEmbedToken, isOriginAllowed } from '@/lib/embed/auth';
import { streamChat } from '@/lib/orchestration/chat';
import { logger } from '@/lib/logging';

const embedChatSchema = z.object({
  message: z.string().min(1).max(10_000),
  conversationId: z.string().max(100).optional(),
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

  logger.info('Embed chat stream started', {
    agentSlug: ctx.agentSlug,
    userId: ctx.userId,
    conversationId: body.conversationId,
  });

  const events = streamChat({
    message: body.message,
    agentSlug: ctx.agentSlug,
    userId: ctx.userId,
    conversationId: body.conversationId,
    signal: request.signal,
  });

  const headers = corsHeaders(origin, ctx.allowedOrigins);
  return sseResponse(events, { signal: request.signal, headers });
}
