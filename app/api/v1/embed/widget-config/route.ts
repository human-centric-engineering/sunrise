/**
 * Embeddable Chat Widget — Resolved Configuration
 *
 * GET /api/v1/embed/widget-config
 *
 * Returns the agent's resolved WidgetConfig (defaults merged with the
 * stored partial). The widget loader fetches this once on boot to apply
 * colours, fonts, and copy via CSS custom properties.
 *
 * Authentication: `X-Embed-Token` header (no session). CORS headers are
 * set dynamically from the token's `allowedOrigins`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getClientIP } from '@/lib/security/ip';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { resolveEmbedToken, isOriginAllowed } from '@/lib/embed/auth';
import { resolveWidgetConfig } from '@/lib/validations/orchestration';

function corsHeaders(origin: string | null, allowedOrigins: string[]): Record<string, string> {
  const effectiveOrigin =
    allowedOrigins.length === 0 ? '*' : origin && allowedOrigins.includes(origin) ? origin : '';

  if (!effectiveOrigin) return {};

  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Embed-Token',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

export async function GET(request: NextRequest): Promise<Response> {
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

  const rateKey = `${token}:${clientIp}`;
  const rateLimit = apiLimiter.check(rateKey);
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

  if (!isOriginAllowed(origin, ctx.allowedOrigins)) {
    return NextResponse.json(
      { success: false, error: { code: 'ORIGIN_DENIED', message: 'Origin not allowed' } },
      { status: 403 }
    );
  }

  const agent = await prisma.aiAgent.findUnique({
    where: { id: ctx.agentId },
    select: { widgetConfig: true },
  });

  const config = resolveWidgetConfig(agent?.widgetConfig);
  const headers = corsHeaders(origin, ctx.allowedOrigins);

  logger.debug('Widget config resolved', { agentSlug: ctx.agentSlug });

  return NextResponse.json({ success: true, data: { config } }, { status: 200, headers });
}
