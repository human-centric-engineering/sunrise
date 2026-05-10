/**
 * Integration Test: Admin Orchestration — Chat Transcribe (POST)
 *
 * POST /api/v1/admin/orchestration/chat/transcribe
 *
 * @see app/api/v1/admin/orchestration/chat/transcribe/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403)
 * - audioLimiter check enforced (429)
 * - Multipart body required (400 INVALID_BODY)
 * - Audio field required (400 MISSING_AUDIO)
 * - Empty audio (400 AUDIO_EMPTY)
 * - Oversize file rejected (413 AUDIO_TOO_LARGE)
 * - Invalid MIME rejected (415 AUDIO_INVALID_TYPE)
 * - agentId required (400 MISSING_AGENT_ID)
 * - Global voice kill switch (403 VOICE_DISABLED)
 * - Agent voice toggle off (403 VOICE_DISABLED)
 * - Agent missing / inactive (404 NOT_FOUND)
 * - No audio provider (503 NO_AUDIO_PROVIDER)
 * - Provider throws (502 TRANSCRIPTION_FAILED)
 * - 200 happy path: returns transcript + durationMs and writes cost log
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn() },
    aiOrchestrationSettings: { findUnique: vi.fn() },
    // Models the route MUST NOT touch — wired here only so the regression
    // test can assert the mocks were never called. If a future contributor
    // wires up audio persistence, the assertions below will trip.
    aiMessage: { create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    aiConversation: { create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    aiKnowledgeDocument: { create: vi.fn() },
    aiKnowledgeChunk: { create: vi.fn(), createMany: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  audioLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getAudioProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { audioLimiter } from '@/lib/security/rate-limit';
import { getAudioProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { POST } from '@/app/api/v1/admin/orchestration/chat/transcribe/route';
import { assertNoAudioPersistence } from '@/tests/helpers/no-audio-persistence';

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu1';

function makeRequestWithFormData(formData: FormData): NextRequest {
  return {
    method: 'POST',
    headers: new Headers(),
    formData: () => Promise.resolve(formData),
    url: 'http://localhost:3000/api/v1/admin/orchestration/chat/transcribe',
  } as unknown as NextRequest;
}

function makeAudioFormData({
  audio = new File([new Uint8Array([1, 2, 3, 4])], 'voice.webm', { type: 'audio/webm' }),
  agentId = AGENT_ID,
  language,
}: {
  audio?: File | string | null;
  agentId?: string | null;
  language?: string;
} = {}): FormData {
  const fd = new FormData();
  if (audio !== null) fd.set('audio', audio as Blob | string);
  if (agentId !== null) fd.set('agentId', agentId);
  if (language !== undefined) fd.set('language', language);
  return fd;
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    enableVoiceInput: true,
    isActive: true,
    ...overrides,
  };
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
  vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
    voiceInputGloballyEnabled: true,
  } as never);
  vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
  vi.mocked(getAudioProvider).mockResolvedValue(makeAudioResolution() as never);
});

describe('Authentication', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(403);
  });
});

describe('Rate limiting', () => {
  it('returns 429 when audioLimiter rejects', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(audioLimiter.check).mockReturnValue({ success: false } as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(429);
  });

  it('keys the limiter by user id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await POST(makeRequestWithFormData(makeAudioFormData()));

    const lastKey = vi.mocked(audioLimiter.check).mock.calls.at(-1)?.[0];
    expect(lastKey).toMatch(/^audio:user:/);
  });
});

describe('Body validation', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 400 when audio field is missing', async () => {
    const response = await POST(makeRequestWithFormData(makeAudioFormData({ audio: null })));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('MISSING_AUDIO');
  });

  it('returns 400 when audio is empty', async () => {
    const empty = new File([], 'voice.webm', { type: 'audio/webm' });
    const response = await POST(makeRequestWithFormData(makeAudioFormData({ audio: empty })));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('AUDIO_EMPTY');
  });

  it('returns 413 when audio exceeds 25 MB', async () => {
    const tooBig = new File([new Uint8Array(26 * 1024 * 1024)], 'big.webm', {
      type: 'audio/webm',
    });
    const response = await POST(makeRequestWithFormData(makeAudioFormData({ audio: tooBig })));

    expect(response.status).toBe(413);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('AUDIO_TOO_LARGE');
  });

  it('returns 415 when MIME type is not allowed', async () => {
    const wrong = new File([new Uint8Array([1, 2, 3])], 'doc.txt', { type: 'text/plain' });
    const response = await POST(makeRequestWithFormData(makeAudioFormData({ audio: wrong })));

    expect(response.status).toBe(415);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('AUDIO_INVALID_TYPE');
  });

  it('accepts audio/webm with codecs param', async () => {
    const ok = new File([new Uint8Array([1, 2])], 'voice.webm', {
      type: 'audio/webm;codecs=opus',
    });
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'hi',
      durationMs: 1000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData({ audio: ok })));

    expect(response.status).toBe(200);
  });

  it('returns 400 when agentId is missing', async () => {
    const response = await POST(makeRequestWithFormData(makeAudioFormData({ agentId: null })));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('MISSING_AGENT_ID');
  });

  it('returns 400 when language is invalid', async () => {
    const response = await POST(
      makeRequestWithFormData(makeAudioFormData({ language: 'not-a-lang!!' }))
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('INVALID_LANGUAGE');
  });
});

describe('Voice toggle gating', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 403 VOICE_DISABLED when global toggle is off', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      voiceInputGloballyEnabled: false,
    } as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(403);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VOICE_DISABLED');
  });

  it('returns 403 VOICE_DISABLED when agent toggle is off', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
      makeAgent({ enableVoiceInput: false }) as never
    );

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(403);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VOICE_DISABLED');
  });

  it('returns 404 NOT_FOUND when agent does not exist', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(404);
  });

  it('returns 404 NOT_FOUND when agent is inactive', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent({ isActive: false }) as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(404);
  });
});

describe('Provider routing', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 503 NO_AUDIO_PROVIDER when no audio provider is configured', async () => {
    vi.mocked(getAudioProvider).mockResolvedValue(null);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(503);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('NO_AUDIO_PROVIDER');
  });

  it('returns 502 TRANSCRIPTION_FAILED when provider throws', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockRejectedValue(new Error('upstream blew up'));
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(502);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('TRANSCRIPTION_FAILED');
  });
});

describe('Happy path', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns transcript text, duration and language on success', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'hello world',
      durationMs: 2500,
      language: 'en',
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { text: string; durationMs: number; language: string } }>(
      response
    );
    expect(body.data.text).toBe('hello world');
    expect(body.data.durationMs).toBe(2500);
    expect(body.data.language).toBe('en');
  });

  it('writes a transcription cost log row tagged to the agent', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'hi',
      durationMs: 5000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        operation: 'transcription',
        durationMs: 5000,
        model: 'whisper-1',
        provider: 'openai',
      })
    );
  });

  it('forwards the language hint to the provider', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'hola',
      durationMs: 1000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    await POST(makeRequestWithFormData(makeAudioFormData({ language: 'es' })));

    expect(audio.provider.transcribe).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ language: 'es' })
    );
  });
});

// ── Hardening: edge cases + abuse vectors ──────────────────────────────────

describe('Cost tracking edge cases', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('writes durationMs=0 cleanly when the provider reports no usage info', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'silence',
      durationMs: 0,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));
    expect(response.status).toBe(200);

    // logCost still fires — calculateTranscriptionCost handles 0 ms as $0.
    // The downstream caller can audit "no usage reported" via the duration
    // field rather than the row being absent entirely.
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'transcription', durationMs: 0 })
    );
  });

  it('omits language metadata when the provider returned no language field', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'no lang',
      durationMs: 1000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    await POST(makeRequestWithFormData(makeAudioFormData()));

    const call = vi.mocked(logCost).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty('metadata');
  });
});

describe('Error envelope hygiene', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('never surfaces the provider error message verbatim to the client', async () => {
    const audio = makeAudioResolution();
    // A provider error containing fragments that look like a leaked secret.
    audio.provider.transcribe.mockRejectedValue(
      new Error('401 Unauthorized: invalid api_key=sk-leaked-12345')
    );
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));
    const body = await parseJson<{ error: { code: string; message: string } }>(response);

    expect(body.error.code).toBe('TRANSCRIPTION_FAILED');
    expect(body.error.message).toBe('Transcription failed');
    expect(body.error.message).not.toContain('sk-');
    expect(body.error.message).not.toContain('api_key');
    expect(body.error.message).not.toContain('Unauthorized');
  });
});

describe('Filename / MIME forwarding', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('forwards the picked filename and content type to the provider', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'ok',
      durationMs: 1000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const file = new File([new Uint8Array([1, 2])], 'recording.mp4', {
      type: 'audio/mp4;codecs=mp4a.40.2',
    });
    await POST(makeRequestWithFormData(makeAudioFormData({ audio: file })));

    expect(audio.provider.transcribe).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({
        filename: 'recording.mp4',
        mimeType: 'audio/mp4;codecs=mp4a.40.2',
      })
    );
  });

  it('falls back to audio.webm when the upload has no filename', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'ok',
      durationMs: 1000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    // Empty filename — the route's `file.name || 'audio.webm'` fallback.
    const file = new File([new Uint8Array([1, 2])], '', { type: 'audio/webm' });
    await POST(makeRequestWithFormData(makeAudioFormData({ audio: file })));

    expect(audio.provider.transcribe).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ filename: 'audio.webm' })
    );
  });
});

describe('Voice toggle interaction with rate limit', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('still consumes the rate limit budget when the request would be rejected as VOICE_DISABLED', async () => {
    // Rate limit is checked before the toggle gate so an attacker can't burn
    // through Whisper budget by spamming voice-disabled agents — but they
    // also shouldn't get a free pass. Each call consumes the bucket.
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
      makeAgent({ enableVoiceInput: false }) as never
    );

    await POST(makeRequestWithFormData(makeAudioFormData()));

    expect(audioLimiter.check).toHaveBeenCalled();
  });
});

// ── Pre-parse body-size guard ──────────────────────────────────────────────

function makeRequestWithContentLength(
  contentLength: string | null,
  formDataSpy?: () => Promise<FormData>
): NextRequest {
  const headers = new Headers();
  if (contentLength !== null) headers.set('content-length', contentLength);
  return {
    method: 'POST',
    headers,
    formData: formDataSpy ?? (() => Promise.resolve(makeAudioFormData())),
    url: 'http://localhost:3000/api/v1/admin/orchestration/chat/transcribe',
  } as unknown as NextRequest;
}

describe('Pre-parse body-size guard', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 413 AUDIO_TOO_LARGE when Content-Length declares an oversized body', async () => {
    const response = await POST(makeRequestWithContentLength('1073741824')); // 1 GB

    expect(response.status).toBe(413);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('AUDIO_TOO_LARGE');
  });

  it('does NOT call request.formData() when the guard rejects (heap protection)', async () => {
    // The whole point of the pre-parse guard: a 1 GB body must NOT be
    // materialised into memory before being rejected.
    const formDataSpy = vi.fn(() => Promise.resolve(makeAudioFormData()));

    await POST(makeRequestWithContentLength('1073741824', formDataSpy));

    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it('passes through when Content-Length is absent (chunked encoding fallback)', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'ok',
      durationMs: 1000,
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makeRequestWithContentLength(null));

    expect(response.status).toBe(200);
  });

  it('still consumes the rate limit budget on oversized rejections', async () => {
    // Auth + rate-limit run before the body cap so an authenticated
    // attacker still pays for their oversize attempts.
    await POST(makeRequestWithContentLength('1073741824'));

    expect(audioLimiter.check).toHaveBeenCalled();
  });
});

// ── Audit invariant: no audio bytes ever reach the database ────────────────

describe('Retention regression — audio is never persisted', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('does not call any AiMessage / AiConversation / AiKnowledge write on the happy path', async () => {
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'hello world',
      durationMs: 2500,
      language: 'en',
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));
    expect(response.status).toBe(200);

    // The route must not write to any table that could store the audio
    // bytes or the transcript directly. The transcript becomes a normal
    // user message via the existing chat send path on a separate request.
    expect(prisma.aiMessage.create).not.toHaveBeenCalled();
    expect(prisma.aiMessage.update).not.toHaveBeenCalled();
    expect(prisma.aiMessage.upsert).not.toHaveBeenCalled();
    expect(prisma.aiConversation.create).not.toHaveBeenCalled();
    expect(prisma.aiConversation.update).not.toHaveBeenCalled();
    expect(prisma.aiConversation.upsert).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.create).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeChunk.create).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeChunk.createMany).not.toHaveBeenCalled();
  });

  it('logCost arguments never carry binary data or audio-shaped keys', async () => {
    // Even cost-log metadata must not stash audio "for analytics" — the
    // helper recursively scans every recorded call argument.
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockResolvedValue({
      text: 'hello',
      durationMs: 1500,
      language: 'en',
      model: 'whisper-1',
    });
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    await POST(makeRequestWithFormData(makeAudioFormData()));

    assertNoAudioPersistence(vi.mocked(logCost), 'logCost');
  });

  it('still does not call AiMessage.create on the error path (TRANSCRIPTION_FAILED)', async () => {
    // Regression guard: a future "save partial transcript" feature would
    // need to take an explicit decision about whether audio survives the
    // failure path. For now: nothing is written.
    const audio = makeAudioResolution();
    audio.provider.transcribe.mockRejectedValue(new Error('upstream blew up'));
    vi.mocked(getAudioProvider).mockResolvedValue(audio as never);

    const response = await POST(makeRequestWithFormData(makeAudioFormData()));
    expect(response.status).toBe(502);

    expect(prisma.aiMessage.create).not.toHaveBeenCalled();
    expect(prisma.aiMessage.update).not.toHaveBeenCalled();
  });
});
