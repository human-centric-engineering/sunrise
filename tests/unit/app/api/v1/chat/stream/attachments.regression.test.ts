/**
 * Regression Tests: POST /api/v1/chat/stream — attachments path
 *
 * Locks in the Phase 5 audit invariants for the consumer chat-stream
 * route's attachment handling:
 *
 *   1. Magic-byte validation rejects forged images (JPEG bytes with a
 *      `image/png` MIME tag) before reaching `streamChat`.
 *   2. PDF magic-byte validation rejects payloads missing the `%PDF-`
 *      header.
 *   3. `imageLimiter` is checked for every attachment-bearing request,
 *      with a distinct rate-limit response when exhausted.
 *   4. Attachment payloads are passed through to `streamChat` unchanged
 *      on the happy path; the route does not persist anything itself.
 *
 * Mirrors the audit invariants in `chat.transcribe.test.ts` for voice.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findFirst: vi.fn(),
    },
    aiAgentInviteToken: { findFirst: vi.fn(), update: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: { check: vi.fn(() => ({ success: true, limit: 100, remaining: 99, reset: 0 })) },
  consumerChatLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
  agentChatLimiter: { check: vi.fn(() => ({ success: true })), reset: vi.fn() },
  imageLimiter: { check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })) },
  createRateLimitResponse: vi.fn(
    () =>
      new Response(JSON.stringify({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED' } }), {
        status: 429,
      })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/orchestration/chat', () => ({ streamChat: vi.fn() }));

vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn(() => new Response('data: test\n\n', { status: 200 })),
}));

vi.mock('@/lib/logging/context', () => ({
  getRequestId: vi.fn(() => Promise.resolve('req-attach-001')),
}));

import { POST } from '@/app/api/v1/chat/stream/route';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';
import { imageLimiter } from '@/lib/security/rate-limit';
import { streamChat } from '@/lib/orchestration/chat';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Real JPEG SOI bytes (FF D8 FF E0 ...) encoded as base64. validateImageMagicBytes
// returns `image/jpeg` for the first 4 bytes; mismatch when the MIME tag
// claims a different format.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKigD//Z';

// A valid PDF starts with %PDF-1.4 ... → base64
const TINY_PDF_BASE64 = Buffer.from('%PDF-1.4\nfake').toString('base64');

function createRequest(body: unknown): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/chat/stream');
  return {
    json: async () => body,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: url.toString(),
    nextUrl: { searchParams: url.searchParams },
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

const mockSession = {
  session: {
    id: 's-1',
    userId: 'u-1',
    token: 't',
    expiresAt: new Date(Date.now() + 86400000),
    ipAddress: '127.0.0.1',
    userAgent: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  user: {
    id: 'u-1',
    name: 'T',
    email: 't@example.com',
    emailVerified: true,
    image: null,
    role: 'USER' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};

const PUBLIC_AGENT = {
  id: 'agent-001',
  slug: 'helper',
  visibility: 'public',
  rateLimitRpm: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
  vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(PUBLIC_AGENT as never);
  vi.mocked(streamChat).mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'start' as const };
    },
  } as never);
  vi.mocked(imageLimiter.check).mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  } as never);
});

async function parseError(res: Response): Promise<{ code: string }> {
  const body = (await res.json()) as { error: { code: string } };
  return { code: body.error.code };
}

describe('Consumer chat stream — attachment regression', () => {
  it('passes a valid PNG attachment through to streamChat', async () => {
    const response = await POST(
      createRequest({
        message: 'What is this?',
        agentSlug: 'helper',
        attachments: [{ name: 'a.png', mediaType: 'image/png', data: TINY_PNG_BASE64 }],
      })
    );
    expect(response.status).toBe(200);
    expect(streamChat).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(streamChat).mock.calls[0][0];
    expect(callArgs.attachments).toHaveLength(1);
    expect(callArgs.attachments?.[0].name).toBe('a.png');
  });

  it('rejects a JPEG masquerading as a PNG with 415 IMAGE_INVALID_TYPE', async () => {
    const response = await POST(
      createRequest({
        message: 'fake',
        agentSlug: 'helper',
        attachments: [{ name: 'a.png', mediaType: 'image/png', data: TINY_JPEG_BASE64 }],
      })
    );
    expect(response.status).toBe(415);
    const err = await parseError(response);
    expect(err.code).toBe('IMAGE_INVALID_TYPE');
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('accepts a valid PDF attachment', async () => {
    const response = await POST(
      createRequest({
        message: 'Parse this',
        agentSlug: 'helper',
        attachments: [{ name: 'doc.pdf', mediaType: 'application/pdf', data: TINY_PDF_BASE64 }],
      })
    );
    expect(response.status).toBe(200);
    expect(streamChat).toHaveBeenCalledOnce();
  });

  it('rejects a non-PDF body with `application/pdf` MIME with 415', async () => {
    const response = await POST(
      createRequest({
        message: 'fake pdf',
        agentSlug: 'helper',
        attachments: [{ name: 'fake.pdf', mediaType: 'application/pdf', data: TINY_PNG_BASE64 }],
      })
    );
    expect(response.status).toBe(415);
    const err = await parseError(response);
    expect(err.code).toBe('IMAGE_INVALID_TYPE');
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('checks imageLimiter for every attachment-bearing request', async () => {
    await POST(
      createRequest({
        message: 'hi',
        agentSlug: 'helper',
        attachments: [{ name: 'a.png', mediaType: 'image/png', data: TINY_PNG_BASE64 }],
      })
    );
    expect(imageLimiter.check).toHaveBeenCalledOnce();
    expect(imageLimiter.check).toHaveBeenCalledWith(`image:user:${mockSession.user.id}`);
  });

  it('returns 429 when the imageLimiter is exhausted', async () => {
    vi.mocked(imageLimiter.check).mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 0,
    } as never);
    const response = await POST(
      createRequest({
        message: 'hi',
        agentSlug: 'helper',
        attachments: [{ name: 'a.png', mediaType: 'image/png', data: TINY_PNG_BASE64 }],
      })
    );
    expect(response.status).toBe(429);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('does NOT call imageLimiter when attachments are absent (no double-bucket)', async () => {
    await POST(createRequest({ message: 'hi', agentSlug: 'helper' }));
    expect(imageLimiter.check).not.toHaveBeenCalled();
  });

  it('does NOT call imageLimiter for an empty attachments array', async () => {
    await POST(createRequest({ message: 'hi', agentSlug: 'helper', attachments: [] }));
    expect(imageLimiter.check).not.toHaveBeenCalled();
  });
});
