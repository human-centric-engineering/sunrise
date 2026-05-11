/**
 * Unit Tests: POST /api/v1/admin/orchestration/chat/stream
 *
 * Tests the admin-facing SSE chat endpoint. Uses withAdminAuth guard
 * and two rate limiters (adminLimiter per IP, chatLimiter per user).
 *
 * Test Coverage:
 * - Happy path: valid request → calls streamChat with correct args → SSE response
 * - Rate limit exceeded (admin IP limiter) → 429
 * - Rate limit exceeded (chat user limiter) → 429
 * - Invalid body: missing required fields → 400 VALIDATION_ERROR
 * - Attachments forwarded to streamChat
 * - Authentication: no session → 401 (delegated to withAdminAuth)
 *
 * @see app/api/v1/admin/orchestration/chat/stream/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/v1/admin/orchestration/chat/stream/route';
import type { NextRequest } from 'next/server';

// Mock Prisma client (needed by withAdminAuth / guards)
vi.mock('@/lib/db/client', () => ({
  prisma: {},
}));

// Mock auth config (needed by withAdminAuth guard)
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Mock rate limiters
vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: {
    check: vi.fn(),
  },
  chatLimiter: {
    check: vi.fn(),
  },
  imageLimiter: {
    // Default to "not rate-limited" so attachment-bearing tests pass through.
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
  createRateLimitResponse: vi.fn(() =>
    Response.json(
      { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' } },
      { status: 429 }
    )
  ),
}));

// Mock IP utility
vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// Mock streamChat
vi.mock('@/lib/orchestration/chat', () => ({
  streamChat: vi.fn(),
}));

// Mock SSE response helper
vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn(() => new Response('data: test\n\n', { status: 200 })),
}));

// Mock logging context
vi.mock('@/lib/logging/context', () => ({
  getRequestId: vi.fn(() => Promise.resolve('req-test-001')),
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import { adminLimiter, chatLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { streamChat } from '@/lib/orchestration/chat';
import { sseResponse } from '@/lib/api/sse';

interface ErrorResponseBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

function createMockRequest(body: unknown): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/chat/stream');
  return {
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
    url: url.toString(),
    nextUrl: { searchParams: url.searchParams },
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

function makeRateLimitResult(success: boolean, remaining = 10) {
  return {
    success,
    limit: 20,
    remaining,
    reset: Math.floor(Date.now() / 1000) + 3600,
  };
}

function createAdminSession(userId = 'admin_test123') {
  return {
    session: {
      id: 'session_admin123',
      userId,
      token: 'mock_token',
      expiresAt: new Date(Date.now() + 86400000),
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: userId,
      name: 'Admin User',
      email: 'admin@example.com',
      emailVerified: true,
      image: null,
      role: 'ADMIN' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

const validPayload = {
  message: 'Hello from admin',
  agentSlug: 'test-agent',
};

describe('POST /api/v1/admin/orchestration/chat/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(createAdminSession());
    vi.mocked(adminLimiter.check).mockReturnValue(makeRateLimitResult(true));
    vi.mocked(chatLimiter.check).mockReturnValue(makeRateLimitResult(true));
  });

  it('returns SSE response on valid request', async () => {
    const req = createMockRequest(validPayload);
    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Hello from admin',
        agentSlug: 'test-agent',
        userId: 'admin_test123',
        requestId: 'req-test-001',
      })
    );
    expect(sseResponse).toHaveBeenCalled();
  });

  it('forwards attachments to streamChat', async () => {
    // Phase 2 hardening: PDF attachments now go through magic-byte
    // validation in the route before reaching streamChat. The payload
    // must start with the `%PDF-` header (base64-encoded) to pass.
    const validPdfBase64 = Buffer.from('%PDF-1.4\nfake').toString('base64');
    const payload = {
      ...validPayload,
      attachments: [{ name: 'doc.pdf', mediaType: 'application/pdf', data: validPdfBase64 }],
    };
    const req = createMockRequest(payload);
    await POST(req);

    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ name: 'doc.pdf', mediaType: 'application/pdf', data: validPdfBase64 }],
      })
    );
  });

  it('forwards optional fields to streamChat', async () => {
    const payload = {
      ...validPayload,
      contextType: 'page',
      contextId: 'page-1',
      entityContext: { key: 'value' },
    };
    const req = createMockRequest(payload);
    await POST(req);

    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        contextType: 'page',
        contextId: 'page-1',
        entityContext: { key: 'value' },
      })
    );
  });

  it('returns 429 when admin IP rate limit is exceeded', async () => {
    vi.mocked(adminLimiter.check).mockReturnValue(makeRateLimitResult(false));

    const req = createMockRequest(validPayload);
    const response = await POST(req);

    expect(response.status).toBe(429);
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('returns 429 when chat user rate limit is exceeded', async () => {
    vi.mocked(chatLimiter.check).mockReturnValue(makeRateLimitResult(false));

    const req = createMockRequest(validPayload);
    const response = await POST(req);

    expect(response.status).toBe(429);
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const req = createMockRequest(validPayload);
    const response = await POST(req);

    expect(response.status).toBe(401);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not admin', async () => {
    const nonAdminSession = createAdminSession();
    nonAdminSession.user.role = 'USER' as 'ADMIN';
    vi.mocked(auth.api.getSession).mockResolvedValue(nonAdminSession);

    const req = createMockRequest(validPayload);
    const response = await POST(req);

    expect(response.status).toBe(403);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid body (missing message)', async () => {
    const req = createMockRequest({ agentSlug: 'test-agent' });
    const response = await POST(req);
    const body = await parseResponse<ErrorResponseBody>(response);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 on invalid body (missing agentSlug)', async () => {
    const req = createMockRequest({ message: 'Hello' });
    const response = await POST(req);
    const body = await parseResponse<ErrorResponseBody>(response);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('passes request signal to sseResponse', async () => {
    const req = createMockRequest(validPayload);
    await POST(req);

    const call = vi.mocked(sseResponse).mock.calls[0];
    expect(call).toBeDefined();
    expect(call[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
