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
import { getAudioProvider, hasModelWithCapability } from '@/lib/orchestration/llm/provider-manager';

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

  const [agent, settings] = await Promise.all([
    prisma.aiAgent.findUnique({
      where: { id: ctx.agentId },
      select: {
        widgetConfig: true,
        enableVoiceInput: true,
        enableImageInput: true,
        enableDocumentInput: true,
      },
    }),
    prisma.aiOrchestrationSettings.findUnique({
      where: { slug: 'global' },
      select: {
        voiceInputGloballyEnabled: true,
        imageInputGloballyEnabled: true,
        documentInputGloballyEnabled: true,
      },
    }),
  ]);

  const config = resolveWidgetConfig(agent?.widgetConfig);
  const headers = corsHeaders(origin, ctx.allowedOrigins);

  // Voice input is exposed to the widget only when:
  //   1. The org-wide kill switch is on (default true).
  //   2. The agent has the per-agent toggle on.
  //   3. There's at least one audio-capable provider configured — checking
  //      this now means the widget never shows a mic button that always
  //      errors with NO_AUDIO_PROVIDER on click.
  let voiceInputEnabled = false;
  if ((!settings || settings.voiceInputGloballyEnabled !== false) && agent?.enableVoiceInput) {
    try {
      const audio = await getAudioProvider();
      voiceInputEnabled = audio !== null;
    } catch (err) {
      logger.warn('voiceInputEnabled probe failed; defaulting to false', {
        agentSlug: ctx.agentSlug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Image / document input mirror voice's triple-gate. Capability
  // existence is queried separately rather than collapsed into a single
  // call so a deployment that only carries `'vision'`-capable models
  // doesn't silently expose the PDF paperclip (which would error with
  // PDF_NOT_SUPPORTED on click).
  let imageInputEnabled = false;
  if ((!settings || settings.imageInputGloballyEnabled !== false) && agent?.enableImageInput) {
    try {
      imageInputEnabled = await hasModelWithCapability('vision');
    } catch (err) {
      logger.warn('imageInputEnabled probe failed; defaulting to false', {
        agentSlug: ctx.agentSlug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let documentInputEnabled = false;
  if (
    (!settings || settings.documentInputGloballyEnabled !== false) &&
    agent?.enableDocumentInput
  ) {
    try {
      documentInputEnabled = await hasModelWithCapability('documents');
    } catch (err) {
      logger.warn('documentInputEnabled probe failed; defaulting to false', {
        agentSlug: ctx.agentSlug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.debug('Widget config resolved', {
    agentSlug: ctx.agentSlug,
    voiceInputEnabled,
    imageInputEnabled,
    documentInputEnabled,
  });

  return NextResponse.json(
    {
      success: true,
      data: { config, voiceInputEnabled, imageInputEnabled, documentInputEnabled },
    },
    { status: 200, headers }
  );
}
