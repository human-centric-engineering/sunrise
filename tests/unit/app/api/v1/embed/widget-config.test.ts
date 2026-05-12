/**
 * Unit Test: Embed Widget Config endpoint
 *
 * GET     /api/v1/embed/widget-config
 * OPTIONS /api/v1/embed/widget-config
 *
 * Behaviours:
 * - Missing X-Embed-Token → 401 MISSING_TOKEN
 * - Invalid/inactive token → 401 INVALID_TOKEN
 * - Origin not in allowedOrigins → 403 ORIGIN_DENIED
 * - allowedOrigins: [] → wildcard CORS, proceeds
 * - widgetConfig stored as null → returns DEFAULT_WIDGET_CONFIG
 * - widgetConfig stored as partial → returns merged config
 * - OPTIONS with token → 204 with CORS headers
 *
 * @see app/api/v1/embed/widget-config/route.ts
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

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getAudioProvider: vi.fn(),
  hasModelWithCapability: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveEmbedToken, isOriginAllowed } from '@/lib/embed/auth';
import { prisma } from '@/lib/db/client';
import { apiLimiter } from '@/lib/security/rate-limit';
import { getAudioProvider, hasModelWithCapability } from '@/lib/orchestration/llm/provider-manager';
import { GET, OPTIONS } from '@/app/api/v1/embed/widget-config/route';
import { DEFAULT_WIDGET_CONFIG } from '@/lib/validations/orchestration';

const VALID_TOKEN = 'tok_valid_1234';
const VALID_CONTEXT = {
  agentId: 'agent-1',
  agentSlug: 'support-bot',
  userId: 'embed_abc123',
  allowedOrigins: ['https://mysite.com'],
};

function makeGetRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(headers),
    url: 'https://mysite.com/api/v1/embed/widget-config',
  } as unknown as NextRequest;
}

function makeOptionsRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    method: 'OPTIONS',
    headers: new Headers(headers),
    url: 'https://mysite.com/api/v1/embed/widget-config',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiLimiter.check).mockReturnValue({ success: true } as never);
  vi.mocked(resolveEmbedToken).mockResolvedValue(VALID_CONTEXT as never);
  vi.mocked(isOriginAllowed).mockReturnValue(true);
  // `vi.clearAllMocks()` wipes any mock implementation set in `vi.mock()`
  // factories — so re-stub the defaults here every run rather than relying
  // on a once-only factory implementation that gets cleared.
  vi.mocked(getAudioProvider).mockResolvedValue(null);
  vi.mocked(hasModelWithCapability).mockResolvedValue(false);
  // Mirror the route's `select` shape so a future select-clause expansion
  // (e.g. adding `isActive`) trips a typed-mock failure rather than silently
  // leaking `undefined` into the route's reads.
  vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
    widgetConfig: null,
    enableVoiceInput: false,
    enableImageInput: false,
    enableDocumentInput: false,
  } as never);
  vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
    voiceInputGloballyEnabled: true,
    imageInputGloballyEnabled: true,
    documentInputGloballyEnabled: true,
  } as never);
});

describe('GET /api/v1/embed/widget-config', () => {
  it('returns 401 MISSING_TOKEN when X-Embed-Token header is absent', async () => {
    const response = await GET(makeGetRequest());
    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('MISSING_TOKEN');
  });

  it('returns 401 INVALID_TOKEN when the token cannot be resolved', async () => {
    vi.mocked(resolveEmbedToken).mockResolvedValue(null);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  it('returns 403 ORIGIN_DENIED when the request origin is not allowed', async () => {
    vi.mocked(isOriginAllowed).mockReturnValue(false);
    const response = await GET(
      makeGetRequest({ 'X-Embed-Token': VALID_TOKEN, Origin: 'https://other.com' })
    );
    expect(response.status).toBe(403);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('ORIGIN_DENIED');
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(apiLimiter.check).mockReturnValue({ success: false } as never);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    expect(response.status).toBe(429);
  });

  it('returns DEFAULT_WIDGET_CONFIG when stored widgetConfig is null', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ widgetConfig: null } as never);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { config: Record<string, unknown> } }>(response);
    expect(body.data.config).toEqual(DEFAULT_WIDGET_CONFIG);
  });

  it('merges a partial stored widgetConfig over defaults', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: { primaryColor: '#16a34a', headerTitle: 'Council Planning' },
    } as never);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { config: Record<string, unknown> } }>(response);
    expect(body.data.config.primaryColor).toBe('#16a34a');
    expect(body.data.config.headerTitle).toBe('Council Planning');
    expect(body.data.config.sendLabel).toBe(DEFAULT_WIDGET_CONFIG.sendLabel);
  });

  it('sets wildcard CORS when allowedOrigins is empty', async () => {
    vi.mocked(resolveEmbedToken).mockResolvedValue({
      ...VALID_CONTEXT,
      allowedOrigins: [],
    } as never);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('echoes the matched origin when allowedOrigins is non-empty', async () => {
    const response = await GET(
      makeGetRequest({ 'X-Embed-Token': VALID_TOKEN, Origin: 'https://mysite.com' })
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://mysite.com');
  });
});

describe('voiceInputEnabled in widget-config response', () => {
  it('is false when the agent toggle is off', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableVoiceInput: false,
    } as never);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { voiceInputEnabled: boolean } }>(response);
    expect(body.data.voiceInputEnabled).toBe(false);
  });

  it('is false when the global kill switch is off, even if agent toggle is on', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableVoiceInput: true,
    } as never);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      voiceInputGloballyEnabled: false,
    } as never);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { voiceInputEnabled: boolean } }>(response);
    expect(body.data.voiceInputEnabled).toBe(false);
  });

  it('is false when no audio-capable provider is configured', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableVoiceInput: true,
    } as never);
    vi.mocked(getAudioProvider).mockResolvedValueOnce(null);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { voiceInputEnabled: boolean } }>(response);
    expect(body.data.voiceInputEnabled).toBe(false);
  });

  it('is false when getAudioProvider rejects (catch branch defaults to false)', async () => {
    // The route swallows getAudioProvider failures and defaults to false so
    // a transient SDK / DB error never bubbles to the partner widget. Without
    // this test the catch arm at route.ts:114-118 went unverified.
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableVoiceInput: true,
    } as never);
    vi.mocked(getAudioProvider).mockRejectedValueOnce(new Error('provider lookup failed'));
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { voiceInputEnabled: boolean } }>(response);
    expect(body.data.voiceInputEnabled).toBe(false);
  });

  it('is true when all three conditions hold', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableVoiceInput: true,
    } as never);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      voiceInputGloballyEnabled: true,
    } as never);
    vi.mocked(getAudioProvider).mockResolvedValueOnce({
      provider: { transcribe: vi.fn() },
      modelId: 'whisper-1',
      providerSlug: 'openai',
    } as never);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { voiceInputEnabled: boolean } }>(response);
    expect(body.data.voiceInputEnabled).toBe(true);
  });
});

describe('imageInputEnabled in widget-config response', () => {
  it('is false when agent toggle is off, even if vision-capable models exist', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableImageInput: false,
    } as never);
    vi.mocked(hasModelWithCapability).mockResolvedValue(true);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { imageInputEnabled: boolean } }>(response);
    expect(body.data.imageInputEnabled).toBe(false);
  });

  it('is false when global kill switch is off, even if agent toggle is on', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableImageInput: true,
    } as never);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      imageInputGloballyEnabled: false,
    } as never);
    vi.mocked(hasModelWithCapability).mockResolvedValue(true);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { imageInputEnabled: boolean } }>(response);
    expect(body.data.imageInputEnabled).toBe(false);
  });

  it('is false when no vision-capable provider is configured, even when both toggles are on', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableImageInput: true,
    } as never);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      imageInputGloballyEnabled: true,
    } as never);
    vi.mocked(hasModelWithCapability).mockImplementation(async (cap) => {
      // documents stays true so we cleanly assert that the missing one
      // (vision) flips imageInputEnabled to false on its own.
      return cap === 'vision' ? false : true;
    });
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { imageInputEnabled: boolean } }>(response);
    expect(body.data.imageInputEnabled).toBe(false);
  });

  it('is true when all three conditions hold', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableImageInput: true,
    } as never);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      imageInputGloballyEnabled: true,
    } as never);
    vi.mocked(hasModelWithCapability).mockResolvedValue(true);
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { imageInputEnabled: boolean } }>(response);
    expect(body.data.imageInputEnabled).toBe(true);
  });
});

describe('documentInputEnabled in widget-config response', () => {
  it('is true only when the documents capability is present', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableDocumentInput: true,
    } as never);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      documentInputGloballyEnabled: true,
    } as never);
    vi.mocked(hasModelWithCapability).mockImplementation(async (cap) => cap === 'documents');
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { documentInputEnabled: boolean } }>(response);
    expect(body.data.documentInputEnabled).toBe(true);
  });

  it('is false when only vision is available (asserts cap separation)', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      widgetConfig: null,
      enableDocumentInput: true,
    } as never);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      documentInputGloballyEnabled: true,
    } as never);
    vi.mocked(hasModelWithCapability).mockImplementation(async (cap) => cap === 'vision');
    const response = await GET(makeGetRequest({ 'X-Embed-Token': VALID_TOKEN }));
    const body = await parseJson<{ data: { documentInputEnabled: boolean } }>(response);
    expect(body.data.documentInputEnabled).toBe(false);
  });
});

describe('OPTIONS /api/v1/embed/widget-config', () => {
  it('returns 204 with wildcard CORS when token is missing (preflight before token is known)', async () => {
    const response = await OPTIONS(makeOptionsRequest());
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('returns 204 with CORS headers when token is valid and origin matches', async () => {
    const response = await OPTIONS(
      makeOptionsRequest({ 'X-Embed-Token': VALID_TOKEN, Origin: 'https://mysite.com' })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://mysite.com');
  });
});
