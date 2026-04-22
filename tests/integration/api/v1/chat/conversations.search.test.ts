/**
 * Integration Test: Consumer Chat — Conversation Search
 *
 * GET /api/v1/chat/conversations/search?q=term
 *
 * @see app/api/v1/chat/conversations/search/route.ts
 *
 * Key assertions:
 * - Returns matching conversations
 * - Scopes to authenticated user only
 * - Returns 401 unauthenticated
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/chat/conversations/search/route';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiMessage: { findMany: vi.fn() },
    aiConversation: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  chatLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/chat/conversations/search');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/chat/conversations/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeRequest({ q: 'hello' }));

    expect(response.status).toBe(401);
  });

  it('returns matching conversations', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([
      { conversationId: 'conv-1' } as never,
      { conversationId: 'conv-2' } as never,
    ]);
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([
      {
        id: 'conv-1',
        title: 'Hello world',
        agent: { id: 'a1', name: 'Bot', slug: 'bot' },
        _count: { messages: 3 },
      } as never,
    ]);
    vi.mocked(prisma.aiConversation.count).mockResolvedValue(1);

    const response = await GET(makeRequest({ q: 'hello' }));

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: unknown[] }>(response);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it('scopes search to authenticated user only', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([]);

    await GET(makeRequest({ q: 'test' }));

    // Verify the message search filters by userId
    expect(prisma.aiMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          content: expect.objectContaining({ contains: 'test' }),
          conversation: expect.objectContaining({
            userId: 'cmjbv4i3x00003wsloputgwul',
          }),
        }),
      })
    );
  });

  it('returns empty results when no matches', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([]);

    const response = await GET(makeRequest({ q: 'nonexistent' }));

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: unknown[] }>(response);
    expect(body.data).toHaveLength(0);
  });
});
