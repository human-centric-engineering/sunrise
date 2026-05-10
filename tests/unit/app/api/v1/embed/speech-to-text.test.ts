/**
 * Unit Test: Embed speech-to-text endpoint
 *
 * POST    /api/v1/embed/speech-to-text
 * OPTIONS /api/v1/embed/speech-to-text
 *
 * Behaviours:
 * - Missing X-Embed-Token → 401 MISSING_TOKEN
 * - Invalid token → 401 INVALID_TOKEN
 * - Origin not allowed → 403 ORIGIN_DENIED
 * - Rate-limited (audioLimiter) → 429
 * - Body validation (missing audio, oversize, invalid MIME) → 400/413/415
 * - Voice toggle gating (global + per-agent)
 * - No audio provider → 503
 * - Provider error → 502 TRANSCRIPTION_FAILED
 * - 200 happy path: transcript + cost log written with embed agent id
 * - OPTIONS returns CORS headers without auth
 *
 * @see app/api/v1/embed/speech-to-text/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/embed/auth', () => ({
  resolveEmbedToken: vi.fn(),
  isOriginAllowed: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn() },
    aiOrchestrationSettings: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  audioLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getAudioProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveEmbedToken, isOriginAllowed } from '@/lib/embed/auth';
import { prisma } from '@/lib/db/client';
import { audioLimiter } from '@/lib/security/rate-limit';
import { getAudioProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { POST, OPTIONS } from '@/app/api/v1/embed/speech-to-text/route';

const VALID_TOKEN = 'tok_valid_1234';
const VALID_CONTEXT = {
  agentId: 'agent-1',
  agentSlug: 'support-bot',
  userId: 'embed_abc123',
  allowedOrigins: ['https://partner.com'],
};

function makeFormData(audio?: File | null, language?: string): FormData {
  const fd = new FormData();
  if (audio !== undefined && audio !== null) {
    fd.set('audio', audio);
  } else if (audio === undefined) {
    fd.set('audio', new File([new Uint8Array([1, 2, 3, 4])], 'voice.webm', { type: 'audio/webm' }));
  }
  if (language) fd.set('language', language);
  return fd;
}

function makePostRequest({
  token = VALID_TOKEN,
  origin = 'https://partner.com',
  formData = makeFormData(),
}: {
  token?: string | null;
  origin?: string | null;
  formData?: FormData;
} = {}): NextRequest {
  const headers = new Headers();
  if (token) headers.set('x-embed-token', token);
  if (origin) headers.set('origin', origin);
  return {
    method: 'POST',
    headers,
    url: 'https://partner.com/api/v1/embed/speech-to-text',
    formData: () => Promise.resolve(formData),
  } as unknown as NextRequest;
}

function makeOptionsRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    method: 'OPTIONS',
    headers: new Headers(headers),
    url: 'https://partner.com/api/v1/embed/speech-to-text',
  } as unknown as NextRequest;
}

function makeAudioResolution() {
  return {
    provider: { transcribe: vi.fn() },
    modelId: 'whisper-1',
    providerSlug: 'openai',
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(audioLimiter.check).mockReturnValue({ success: true } as never);
  vi.mocked(resolveEmbedToken).mockResolvedValue(VALID_CONTEXT as never);
  vi.mocked(isOriginAllowed).mockReturnValue(true);
  vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
    voiceInputGloballyEnabled: true,
  } as never);
  vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
    id: VALID_CONTEXT.agentId,
    enableVoiceInput: true,
    isActive: true,
  } as never);
});

describe('POST /api/v1/embed/speech-to-text — auth', () => {
  it('returns 401 when X-Embed-Token is missing', async () => {
    const response = await POST(makePostRequest({ token: null }));

    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('MISSING_TOKEN');
  });

  it('returns 401 when token resolves to null', async () => {
    vi.mocked(resolveEmbedToken).mockResolvedValue(null);

    const response = await POST(makePostRequest());

    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  it('returns 403 when origin is not allowed', async () => {
    vi.mocked(isOriginAllowed).mockReturnValue(false);

    const response = await POST(makePostRequest());

    expect(response.status).toBe(403);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('ORIGIN_DENIED');
  });
});

describe('POST /api/v1/embed/speech-to-text — rate limit', () => {
  it('returns 429 when audioLimiter rejects', async () => {
    vi.mocked(audioLimiter.check).mockReturnValue({ success: false } as never);

    const response = await POST(makePostRequest());

    expect(response.status).toBe(429);
  });

  it('keys the limiter by token + IP', async () => {
    await POST(makePostRequest());
    const lastKey = vi.mocked(audioLimiter.check).mock.calls.at(-1)?.[0];
    expect(lastKey).toMatch(/^audio:embed:/);
    expect(lastKey).toContain(VALID_TOKEN);
    expect(lastKey).toContain('127.0.0.1');
  });
});

describe('POST /api/v1/embed/speech-to-text — voice toggle gating', () => {
  it('returns 403 VOICE_DISABLED when global flag is off', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      voiceInputGloballyEnabled: false,
    } as never);

    const response = await POST(makePostRequest());

    expect(response.status).toBe(403);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VOICE_DISABLED');
  });

  it('returns 403 VOICE_DISABLED when agent toggle is off', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: VALID_CONTEXT.agentId,
      enableVoiceInput: false,
      isActive: true,
    } as never);

    const response = await POST(makePostRequest());

    expect(response.status).toBe(403);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VOICE_DISABLED');
  });
});

describe('POST /api/v1/embed/speech-to-text — body validation', () => {
  it('returns 413 AUDIO_TOO_LARGE for oversize file', async () => {
    const tooBig = new File([new Uint8Array(26 * 1024 * 1024)], 'big.webm', {
      type: 'audio/webm',
    });
    const response = await POST(makePostRequest({ formData: makeFormData(tooBig) }));

    expect(response.status).toBe(413);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('AUDIO_TOO_LARGE');
  });

  it('returns 415 AUDIO_INVALID_TYPE for non-audio MIME', async () => {
    const wrong = new File([new Uint8Array([1, 2])], 'doc.txt', { type: 'text/plain' });
    const response = await POST(makePostRequest({ formData: makeFormData(wrong) }));

    expect(response.status).toBe(415);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('AUDIO_INVALID_TYPE');
  });
});

describe('POST /api/v1/embed/speech-to-text — provider routing', () => {
  it('returns 503 NO_AUDIO_PROVIDER when no provider is configured', async () => {
    vi.mocked(getAudioProvider).mockResolvedValue(null);

    const response = await POST(makePostRequest());

    expect(response.status).toBe(503);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('NO_AUDIO_PROVIDER');
  });

  it('returns 502 TRANSCRIPTION_FAILED on provider error', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockRejectedValue(new Error('upstream failure'));
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makePostRequest());

    expect(response.status).toBe(502);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('TRANSCRIPTION_FAILED');
  });
});

describe('POST /api/v1/embed/speech-to-text — happy path', () => {
  it('returns transcript and writes a cost log tagged to the embed agent', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'embed transcript',
      durationMs: 4000,
      language: 'en',
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makePostRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { text: string; durationMs: number } }>(response);
    expect(body.data.text).toBe('embed transcript');
    expect(body.data.durationMs).toBe(4000);

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: VALID_CONTEXT.agentId,
        operation: 'transcription',
        durationMs: 4000,
        provider: 'openai',
        model: 'whisper-1',
      })
    );
  });

  it('attaches CORS headers to the success response', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'ok',
      durationMs: 1000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makePostRequest());

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://partner.com');
  });
});

// ── Hardening: edge cases + abuse vectors ──────────────────────────────────

describe('POST /api/v1/embed/speech-to-text — token authority over body agentId', () => {
  it('ignores any agentId in the multipart body and uses the token-resolved agentId', async () => {
    // A malicious widget could try to bill cost to a different agent by
    // sending its id in the body. The token's resolved agentId is the only
    // authority — the form value must not affect routing or cost attribution.
    const fd = makeFormData();
    fd.set('agentId', 'agent-MALICIOUS');

    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'ok',
      durationMs: 2000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makePostRequest({ formData: fd }));

    expect(response.status).toBe(200);
    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith({
      where: { id: VALID_CONTEXT.agentId },
      select: expect.any(Object),
    });
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: VALID_CONTEXT.agentId })
    );
  });
});

describe('POST /api/v1/embed/speech-to-text — origin handling', () => {
  it('rejects with ORIGIN_DENIED when the request omits the Origin header but allowedOrigins is non-empty', async () => {
    vi.mocked(isOriginAllowed).mockReturnValue(false);
    const response = await POST(makePostRequest({ origin: null }));
    expect(response.status).toBe(403);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('ORIGIN_DENIED');
  });

  it('allows missing Origin when the token has empty allowedOrigins (server-to-server use)', async () => {
    vi.mocked(resolveEmbedToken).mockResolvedValue({
      ...VALID_CONTEXT,
      allowedOrigins: [],
    } as never);
    vi.mocked(isOriginAllowed).mockReturnValue(true);
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'ok',
      durationMs: 1000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makePostRequest({ origin: null }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('POST /api/v1/embed/speech-to-text — CORS on validation failures', () => {
  it('attaches CORS headers to a 413 AUDIO_TOO_LARGE response so the partner origin can read it', async () => {
    const tooBig = new File([new Uint8Array(26 * 1024 * 1024)], 'big.webm', {
      type: 'audio/webm',
    });
    const response = await POST(makePostRequest({ formData: makeFormData(tooBig) }));

    expect(response.status).toBe(413);
    // Without CORS headers on the error path, the embedded widget on the
    // partner origin can't read the JSON body and surfaces a generic
    // "fetch failed" instead of the AUDIO_TOO_LARGE specific message.
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://partner.com');
  });

  it('attaches CORS headers to a 415 AUDIO_INVALID_TYPE response', async () => {
    const wrong = new File([new Uint8Array([1, 2])], 'doc.txt', { type: 'text/plain' });
    const response = await POST(makePostRequest({ formData: makeFormData(wrong) }));

    expect(response.status).toBe(415);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://partner.com');
  });
});

describe('POST /api/v1/embed/speech-to-text — cost-log shape', () => {
  it('does not write a `language` metadata key when the provider returned no language', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'no lang',
      durationMs: 1000,
      model: 'whisper-1',
      // language: undefined — provider could omit when audio is too short to detect
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    await POST(makePostRequest());

    const call = vi.mocked(logCost).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty('metadata');
  });

  it('records durationMs=0 cleanly when the provider reports no usage', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'silence',
      durationMs: 0,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makePostRequest());
    expect(response.status).toBe(200);

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'transcription',
        durationMs: 0,
      })
    );
  });
});

describe('POST /api/v1/embed/speech-to-text — error envelope shape', () => {
  it('does not leak provider error message text into the response body', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockRejectedValue(
      new Error('OpenAI rate limit hit; key sk-... please rotate')
    );
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makePostRequest());
    const body = await parseJson<{ error: { code: string; message: string } }>(response);

    // Generic message — provider details stay in server logs, never the body.
    expect(body.error.code).toBe('TRANSCRIPTION_FAILED');
    expect(body.error.message).not.toContain('sk-');
    expect(body.error.message).not.toContain('rate limit');
    expect(body.error.message).toBe('Transcription failed');
  });
});

describe('OPTIONS /api/v1/embed/speech-to-text', () => {
  it('returns 204 with CORS headers when token resolves', async () => {
    const response = await OPTIONS(
      makeOptionsRequest({ 'x-embed-token': VALID_TOKEN, origin: 'https://partner.com' })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('returns 204 even without a token (for CORS preflight)', async () => {
    const response = await OPTIONS(makeOptionsRequest());

    expect(response.status).toBe(204);
  });
});
