/**
 * Embed Widget — Speech-to-text transcription
 *
 * POST /api/v1/embed/speech-to-text
 *
 * Multipart upload from the embed widget. Same shape as the admin
 * endpoint but authenticated via `X-Embed-Token` instead of session.
 * The token resolves to an agentId + allowedOrigins; the request body
 * carries the audio bytes plus an optional language hint. The agentId
 * field in the multipart body is ignored — the embed token is the
 * authority on which agent owns this conversation.
 *
 * Audio is streamed straight to the configured audio-capable provider
 * and discarded after transcription.
 *
 * Voice input must be enabled per-agent (`AiAgent.enableVoiceInput`)
 * AND globally (`AiOrchestrationSettings.voiceInputGloballyEnabled`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { logger } from '@/lib/logging';
import { getClientIP } from '@/lib/security/ip';
import { audioLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { isOriginAllowed, resolveEmbedToken } from '@/lib/embed/auth';
import { getAudioProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { enforceContentLengthCap, validateTranscribeUpload } from '@/lib/validations/transcribe';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(origin, ctx?.allowedOrigins ?? []),
  });
}

// Audit invariant: this handler MUST NOT persist audio bytes. The only DB
// write on the happy path is `logCost(...)` for billing. Enforced by the
// retention regression tests in tests/unit/app/api/v1/embed/speech-to-text.test.ts.
export async function POST(request: NextRequest): Promise<Response> {
  const origin = request.headers.get('origin');
  const token = request.headers.get('x-embed-token');

  if (!token) {
    return errorResponse('X-Embed-Token header required', {
      code: 'MISSING_TOKEN',
      status: 401,
    });
  }

  const clientIp = getClientIP(request);
  const rateLimit = audioLimiter.check(`audio:embed:${token}:${clientIp}`);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const ctx = await resolveEmbedToken(token, clientIp);
  if (!ctx) {
    return errorResponse('Invalid or inactive embed token', {
      code: 'INVALID_TOKEN',
      status: 401,
    });
  }

  if (!isOriginAllowed(origin, ctx.allowedOrigins)) {
    return errorResponse('Origin not allowed', { code: 'ORIGIN_DENIED', status: 403 });
  }

  const headers = corsHeaders(origin, ctx.allowedOrigins);

  const oversize = enforceContentLengthCap(request);
  if (oversize) {
    // Re-wrap with CORS so the partner origin can read the 413 body.
    const cloned = new Response(oversize.body, {
      status: oversize.status,
      headers: { ...Object.fromEntries(oversize.headers.entries()), ...headers },
    });
    return cloned;
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse('Expected multipart/form-data body', {
      code: 'INVALID_BODY',
      status: 400,
      headers,
    });
  }

  // The embed token is the authority on agent identity. We still validate
  // the multipart shape — but the validator's agentId requirement is
  // satisfied by injecting the token's resolved agentId before the check
  // so widgets don't have to send it explicitly.
  if (!formData.has('agentId')) formData.set('agentId', ctx.agentId);

  const validation = validateTranscribeUpload(formData);
  if (!validation.ok) {
    // Attach CORS headers to the validator's error response.
    const original = validation.response;
    const cloned = new Response(original.body, {
      status: original.status,
      headers: { ...Object.fromEntries(original.headers.entries()), ...headers },
    });
    return cloned;
  }
  const { file, language } = validation.value;

  const settings = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { voiceInputGloballyEnabled: true },
  });
  if (settings && !settings.voiceInputGloballyEnabled) {
    return errorResponse('Voice input is disabled at the platform level', {
      code: 'VOICE_DISABLED',
      status: 403,
      headers,
    });
  }

  const agent = await prisma.aiAgent.findUnique({
    where: { id: ctx.agentId },
    select: { id: true, enableVoiceInput: true, isActive: true },
  });
  if (!agent || !agent.isActive) {
    return errorResponse('Agent not available', { code: 'NOT_FOUND', status: 404, headers });
  }
  if (!agent.enableVoiceInput) {
    return errorResponse('Voice input is not enabled for this agent', {
      code: 'VOICE_DISABLED',
      status: 403,
      headers,
    });
  }

  const audio = await getAudioProvider();
  if (!audio) {
    return errorResponse('No audio-capable provider is configured', {
      code: 'NO_AUDIO_PROVIDER',
      status: 503,
      headers,
    });
  }

  try {
    const result = await audio.provider.transcribe(file, {
      model: audio.modelId,
      ...(language ? { language } : {}),
      mimeType: file.type,
      filename: file.name || 'audio.webm',
    });

    void logCost({
      agentId: agent.id,
      model: audio.modelId,
      provider: audio.providerSlug,
      inputTokens: 0,
      outputTokens: 0,
      operation: 'transcription',
      durationMs: result.durationMs,
      ...(result.language ? { metadata: { language: result.language } } : {}),
    });

    logger.info('Embed audio transcribed', {
      agentSlug: ctx.agentSlug,
      provider: audio.providerSlug,
      model: audio.modelId,
      durationMs: result.durationMs,
      bytes: file.size,
    });

    return successResponse(
      {
        text: result.text,
        durationMs: result.durationMs,
        ...(result.language ? { language: result.language } : {}),
      },
      undefined,
      { headers }
    );
  } catch (err) {
    logger.error('Embed transcription failed', {
      agentSlug: ctx.agentSlug,
      provider: audio.providerSlug,
      model: audio.modelId,
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof ProviderError ? err.code : undefined,
    });
    return errorResponse('Transcription failed', {
      code: 'TRANSCRIPTION_FAILED',
      status: 502,
      headers,
    });
  }
}
