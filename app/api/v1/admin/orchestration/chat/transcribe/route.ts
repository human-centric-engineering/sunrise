/**
 * Admin Orchestration — Speech-to-text transcription
 *
 * POST /api/v1/admin/orchestration/chat/transcribe
 *
 * Multipart upload (audio bytes + agentId). Returns the transcript text
 * plus the audio duration so the caller can show "x seconds transcribed".
 *
 * Authentication: Admin role required.
 * Rate limit: 10 requests/min per user (audioLimiter).
 *
 * Audio is streamed straight to the configured audio-capable provider
 * (e.g. OpenAI Whisper) and discarded after transcription. The transcript
 * becomes a normal user message via the existing chat send flow — this
 * endpoint does not persist the audio.
 *
 * Voice input must be enabled both per-agent (`AiAgent.enableVoiceInput`)
 * and globally (`AiOrchestrationSettings.voiceInputGloballyEnabled`).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { audioLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getAudioProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { validateTranscribeUpload } from '@/lib/validations/transcribe';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const rateLimit = audioLimiter.check(`audio:user:${session.user.id}`);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse('Expected multipart/form-data body', {
      code: 'INVALID_BODY',
      status: 400,
    });
  }

  const validation = validateTranscribeUpload(formData);
  if (!validation.ok) return validation.response;
  const { file, agentId, language } = validation.value;

  const settings = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { voiceInputGloballyEnabled: true },
  });
  if (settings && !settings.voiceInputGloballyEnabled) {
    return errorResponse('Voice input is disabled at the platform level', {
      code: 'VOICE_DISABLED',
      status: 403,
    });
  }

  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { id: true, enableVoiceInput: true, isActive: true },
  });
  if (!agent || !agent.isActive) {
    return errorResponse('Agent not found', { code: 'NOT_FOUND', status: 404 });
  }
  if (!agent.enableVoiceInput) {
    return errorResponse('Voice input is not enabled for this agent', {
      code: 'VOICE_DISABLED',
      status: 403,
    });
  }

  const audio = await getAudioProvider();
  if (!audio) {
    return errorResponse('No audio-capable provider is configured', {
      code: 'NO_AUDIO_PROVIDER',
      status: 503,
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

    log.info('Audio transcribed', {
      agentId: agent.id,
      provider: audio.providerSlug,
      model: audio.modelId,
      durationMs: result.durationMs,
      bytes: file.size,
    });

    return successResponse({
      text: result.text,
      durationMs: result.durationMs,
      ...(result.language ? { language: result.language } : {}),
    });
  } catch (err) {
    log.error('Transcription failed', {
      agentId: agent.id,
      provider: audio.providerSlug,
      model: audio.modelId,
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof ProviderError ? err.code : undefined,
    });
    return errorResponse('Transcription failed', {
      code: 'TRANSCRIPTION_FAILED',
      status: 502,
    });
  }
});
