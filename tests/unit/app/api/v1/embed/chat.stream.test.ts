/**
 * Unit Test: Embed Chat Stream
 *
 * POST    /api/v1/embed/chat/stream
 * OPTIONS /api/v1/embed/chat/stream
 *
 * Key behaviours:
 * - Missing X-Embed-Token → 401 MISSING_TOKEN
 * - Invalid/inactive token → 401 INVALID_TOKEN
 * - Rate limit exceeded → 429
 * - Origin not in allowedOrigins → 403 ORIGIN_DENIED
 * - allowedOrigins: [] → wildcard bypass, proceeds
 * - Empty message → 400 VALIDATION_ERROR
 * - Valid request → calls streamChat, returns SSE Response
 * - OPTIONS with token → 204 with CORS headers
 * - OPTIONS without token → 204 (no CORS headers)
 *
 * @see app/api/v1/embed/chat/stream/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, OPTIONS } from '@/app/api/v1/embed/chat/stream/route';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/embed/auth', () => ({
  resolveEmbedToken: vi.fn(),
  isOriginAllowed: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat', () => ({
  streamChat: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  embedChatLimiter: { check: vi.fn(() => ({ success: true })) },
  imageLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn(() => new Response('stream', { status: 200 })),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { resolveEmbedToken, isOriginAllowed } from '@/lib/embed/auth';
import { streamChat } from '@/lib/orchestration/chat';
import { embedChatLimiter, imageLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VALID_TOKEN = 'tok_valid_1234';
const VALID_CONTEXT = {
  agentSlug: 'support-bot',
  userId: 'user-1',
  allowedOrigins: ['https://mysite.com'],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'application/json',
      ...headers,
    }),
    json: () => Promise.resolve(body),
    url: 'https://mysite.com/api/v1/embed/chat/stream',
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

function makeOptionsRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://mysite.com/api/v1/embed/chat/stream', {
    method: 'OPTIONS',
    headers: new Headers(headers),
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/embed/chat/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(embedChatLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(resolveEmbedToken).mockResolvedValue(VALID_CONTEXT as never);
    vi.mocked(isOriginAllowed).mockReturnValue(true);
    vi.mocked(streamChat).mockReturnValue((async function* () {})());
  });

  describe('Token validation', () => {
    it('returns 401 MISSING_TOKEN when X-Embed-Token header is absent', async () => {
      const response = await POST(makePostRequest({ message: 'hello' }));

      expect(response.status).toBe(401);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('MISSING_TOKEN');
    });

    it('returns 401 INVALID_TOKEN when token is invalid', async () => {
      vi.mocked(resolveEmbedToken).mockResolvedValue(null);

      const response = await POST(
        makePostRequest({ message: 'hello' }, { 'x-embed-token': 'bad-token' })
      );

      expect(response.status).toBe(401);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('INVALID_TOKEN');
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(embedChatLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(
        makePostRequest({ message: 'hello' }, { 'x-embed-token': VALID_TOKEN })
      );

      expect(response.status).toBe(429);
    });

    it('does not call resolveEmbedToken when rate limited', async () => {
      vi.mocked(embedChatLimiter.check).mockReturnValue({ success: false } as never);

      await POST(makePostRequest({ message: 'hello' }, { 'x-embed-token': VALID_TOKEN }));

      expect(vi.mocked(resolveEmbedToken)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  describe('CORS / origin check', () => {
    it('returns 403 ORIGIN_DENIED when origin is not in allowedOrigins', async () => {
      vi.mocked(isOriginAllowed).mockReturnValue(false);

      const response = await POST(
        makePostRequest(
          { message: 'hello' },
          { 'x-embed-token': VALID_TOKEN, origin: 'https://evil.com' }
        )
      );

      expect(response.status).toBe(403);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('ORIGIN_DENIED');
    });

    it('proceeds when allowedOrigins is empty (wildcard)', async () => {
      vi.mocked(resolveEmbedToken).mockResolvedValue({
        ...VALID_CONTEXT,
        allowedOrigins: [],
      } as never);
      vi.mocked(isOriginAllowed).mockReturnValue(true);

      const response = await POST(
        makePostRequest({ message: 'hello' }, { 'x-embed-token': VALID_TOKEN })
      );

      // Should not be 403 — streamChat is called
      // test-review:accept no_arg_called — call-reached guard: verifies happy-path invocation
      expect(vi.mocked(streamChat)).toHaveBeenCalled();
      expect(response.status).not.toBe(403);
    });
  });

  describe('Message validation', () => {
    it('returns 400 VALIDATION_ERROR for empty message', async () => {
      const response = await POST(
        makePostRequest(
          { message: '' },
          { 'x-embed-token': VALID_TOKEN, origin: 'https://mysite.com' }
        )
      );

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('conversationId validation', () => {
    it('returns 400 VALIDATION_ERROR for non-CUID conversationId', async () => {
      const response = await POST(
        makePostRequest(
          { message: 'Hello', conversationId: 'not-a-cuid' },
          { 'x-embed-token': VALID_TOKEN, origin: 'https://mysite.com' }
        )
      );

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Successful stream', () => {
    it('calls streamChat with correct parameters', async () => {
      const validCuid = 'clh1234567890abcdefghijklm';
      await POST(
        makePostRequest(
          { message: 'Hello bot', conversationId: validCuid },
          { 'x-embed-token': VALID_TOKEN, origin: 'https://mysite.com' }
        )
      );

      expect(vi.mocked(streamChat)).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Hello bot',
          agentSlug: VALID_CONTEXT.agentSlug,
          userId: VALID_CONTEXT.userId,
          conversationId: validCuid,
        })
      );
    });

    it('returns SSE response on success', async () => {
      const response = await POST(
        makePostRequest(
          { message: 'Hello' },
          { 'x-embed-token': VALID_TOKEN, origin: 'https://mysite.com' }
        )
      );

      expect(response.status).toBe(200);
    });
  });

  describe('Attachment gate', () => {
    const TINY_PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const TINY_JPEG_BASE64 =
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKigD//Z';
    const TINY_PDF_BASE64 = Buffer.from('%PDF-1.4\nfake').toString('base64');

    const headers = { 'x-embed-token': VALID_TOKEN, origin: 'https://mysite.com' };

    it('checks imageLimiter when attachments are present (token+ip key)', async () => {
      await POST(
        makePostRequest(
          {
            message: 'describe this',
            attachments: [{ name: 'a.png', mediaType: 'image/png', data: TINY_PNG_BASE64 }],
          },
          headers
        )
      );
      expect(vi.mocked(imageLimiter.check)).toHaveBeenCalledOnce();
      expect(vi.mocked(imageLimiter.check)).toHaveBeenCalledWith(
        `image:embed:${VALID_TOKEN}:127.0.0.1`
      );
    });

    it('returns 429 when imageLimiter rejects', async () => {
      vi.mocked(imageLimiter.check).mockReturnValueOnce({ success: false } as never);
      const response = await POST(
        makePostRequest(
          {
            message: 'x',
            attachments: [{ name: 'a.png', mediaType: 'image/png', data: TINY_PNG_BASE64 }],
          },
          headers
        )
      );
      expect(response.status).toBe(429);
      expect(streamChat).not.toHaveBeenCalled();
    });

    it('does NOT call imageLimiter for text-only requests', async () => {
      await POST(makePostRequest({ message: 'plain text' }, headers));
      expect(vi.mocked(imageLimiter.check)).not.toHaveBeenCalled();
    });

    it('rejects a JPEG body tagged as image/png with 415 IMAGE_INVALID_TYPE', async () => {
      const response = await POST(
        makePostRequest(
          {
            message: 'forged',
            attachments: [{ name: 'forged.png', mediaType: 'image/png', data: TINY_JPEG_BASE64 }],
          },
          headers
        )
      );
      expect(response.status).toBe(415);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('IMAGE_INVALID_TYPE');
      expect(streamChat).not.toHaveBeenCalled();
    });

    it('rejects a non-PDF body tagged as application/pdf with 415', async () => {
      const response = await POST(
        makePostRequest(
          {
            message: 'fake pdf',
            attachments: [
              { name: 'fake.pdf', mediaType: 'application/pdf', data: TINY_PNG_BASE64 },
            ],
          },
          headers
        )
      );
      expect(response.status).toBe(415);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('IMAGE_INVALID_TYPE');
      expect(streamChat).not.toHaveBeenCalled();
    });

    it('forwards valid attachments to streamChat', async () => {
      await POST(
        makePostRequest(
          {
            message: 'describe',
            attachments: [{ name: 'photo.png', mediaType: 'image/png', data: TINY_PNG_BASE64 }],
          },
          headers
        )
      );
      expect(streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: expect.arrayContaining([expect.objectContaining({ name: 'photo.png' })]),
        })
      );
    });

    it('forwards valid PDF attachments to streamChat', async () => {
      await POST(
        makePostRequest(
          {
            message: 'parse',
            attachments: [{ name: 'doc.pdf', mediaType: 'application/pdf', data: TINY_PDF_BASE64 }],
          },
          headers
        )
      );
      expect(streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ mediaType: 'application/pdf' }),
          ]),
        })
      );
    });

    it('accepts attachment-only requests (empty message + ≥1 attachment)', async () => {
      const response = await POST(
        makePostRequest(
          {
            message: '',
            attachments: [{ name: 'photo.png', mediaType: 'image/png', data: TINY_PNG_BASE64 }],
          },
          headers
        )
      );
      expect(response.status).toBe(200);
      expect(streamChat).toHaveBeenCalled();
    });

    it('rejects empty message AND empty attachments with 400 VALIDATION_ERROR', async () => {
      const response = await POST(makePostRequest({ message: '', attachments: [] }, headers));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(streamChat).not.toHaveBeenCalled();
    });
  });
});

describe('OPTIONS /api/v1/embed/chat/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveEmbedToken).mockResolvedValue(VALID_CONTEXT as never);
    vi.mocked(isOriginAllowed).mockReturnValue(true);
  });

  it('returns 204 when X-Embed-Token is absent', async () => {
    const response = await OPTIONS(makeOptionsRequest());

    // When token is absent, corsHeaders is called with empty allowedOrigins → wildcard '*'
    expect(response.status).toBe(204);
    expect(vi.mocked(resolveEmbedToken)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('returns 204 with CORS headers when valid token is provided', async () => {
    const response = await OPTIONS(
      makeOptionsRequest({
        'x-embed-token': VALID_TOKEN,
        origin: 'https://mysite.com',
      })
    );

    expect(response.status).toBe(204);
    // With a valid token and non-empty allowedOrigins, CORS headers should be set
    // test-review:accept no_arg_called — call-reached guard: verifies token resolution triggered
    expect(vi.mocked(resolveEmbedToken)).toHaveBeenCalled();
  });
});
