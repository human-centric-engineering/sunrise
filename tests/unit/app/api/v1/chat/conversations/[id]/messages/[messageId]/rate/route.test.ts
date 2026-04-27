/**
 * Unit Test: POST /api/v1/chat/conversations/:id/messages/:messageId/rate
 *
 * Tests the consumer message rating endpoint (thumbs up/down).
 *
 * Test Coverage:
 * - Happy path: rates an assistant message (thumbs up)
 * - Happy path: rates an assistant message (thumbs down)
 * - Rejects non-assistant messages (404)
 * - Rejects messages from other users' conversations (404)
 * - Rejects invalid rating values (400)
 * - Rejects invalid conversation/message IDs (400)
 * - Rate limiting (429)
 * - Authentication required (401)
 *
 * @see app/api/v1/chat/conversations/[id]/messages/[messageId]/rate/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: { findFirst: vi.fn() },
    aiMessage: { findFirst: vi.fn(), update: vi.fn() },
  },
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

// ─── Imports ────────────────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/chat/conversations/[id]/messages/[messageId]/rate/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { apiLimiter } from '@/lib/security/rate-limit';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

const CONV_ID = 'cmjbv4i3x00003wsloputgwul';
const MSG_ID = 'cmjbv4i3x00004wsloputgwum';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';

function makeRequest(body: unknown): NextRequest {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeParams(convId = CONV_ID, msgId = MSG_ID) {
  return { params: Promise.resolve({ id: convId, messageId: msgId }) };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /chat/conversations/:id/messages/:messageId/rate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(apiLimiter.check).mockReturnValue({ success: true } as never);
  });

  it('rates an assistant message thumbs up', async () => {
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({
      id: CONV_ID,
      userId: USER_ID,
    } as never);
    vi.mocked(prisma.aiMessage.findFirst).mockResolvedValue({
      id: MSG_ID,
      role: 'assistant',
      conversationId: CONV_ID,
    } as never);
    vi.mocked(prisma.aiMessage.update).mockResolvedValue({
      id: MSG_ID,
      rating: 1,
      ratedAt: new Date(),
    } as never);

    const res = await POST(makeRequest({ rating: 1 }), makeParams());
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.message.rating).toBe(1);
  });

  it('rates an assistant message thumbs down', async () => {
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({
      id: CONV_ID,
      userId: USER_ID,
    } as never);
    vi.mocked(prisma.aiMessage.findFirst).mockResolvedValue({
      id: MSG_ID,
      role: 'assistant',
      conversationId: CONV_ID,
    } as never);
    vi.mocked(prisma.aiMessage.update).mockResolvedValue({
      id: MSG_ID,
      rating: -1,
      ratedAt: new Date(),
    } as never);

    const res = await POST(makeRequest({ rating: -1 }), makeParams());
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.message.rating).toBe(-1);
  });

  it('returns 404 when conversation not found (wrong user)', async () => {
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);

    const res = await POST(makeRequest({ rating: 1 }), makeParams());

    expect(res.status).toBe(404);
    expect(prisma.aiMessage.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('returns 404 when message is not an assistant message', async () => {
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({
      id: CONV_ID,
      userId: USER_ID,
    } as never);
    vi.mocked(prisma.aiMessage.findFirst).mockResolvedValue(null);

    const res = await POST(makeRequest({ rating: 1 }), makeParams());

    expect(res.status).toBe(404);
  });

  it('rejects invalid rating value (400)', async () => {
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({
      id: CONV_ID,
      userId: USER_ID,
    } as never);

    const res = await POST(makeRequest({ rating: 0 }), makeParams());

    expect(res.status).toBe(400);
  });

  it('rejects invalid conversation ID (400)', async () => {
    const res = await POST(makeRequest({ rating: 1 }), makeParams('not-a-cuid', MSG_ID));

    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(apiLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    const res = await POST(makeRequest({ rating: 1 }), makeParams());

    expect(res.status).toBe(429);
  });

  it('rejects unauthenticated requests (401)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const res = await POST(makeRequest({ rating: 1 }), makeParams());

    expect(res.status).toBe(401);
  });
});
