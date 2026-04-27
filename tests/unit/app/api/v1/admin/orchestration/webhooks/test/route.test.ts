/**
 * Tests: Admin Orchestration — Webhook Test (send ping)
 *
 * POST /api/v1/admin/orchestration/webhooks/:id/test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookSubscription: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { POST } from '@/app/api/v1/admin/orchestration/webhooks/[id]/test/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const WEBHOOK_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    url: 'https://example.com/webhook',
    secret: 'my-secret',
    createdBy: 'user-1',
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(id = WEBHOOK_ID): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/webhooks/${id}/test`, {
    method: 'POST',
  });
}

function makeParams(id = WEBHOOK_ID) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
});

describe('POST /webhooks/:id/test', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makeRequest(), makeParams());

    expect(response.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: {
        id: 'session_1',
        userId: 'user_1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: 'user_1',
        name: 'Regular User',
        email: 'user@example.com',
        emailVerified: true,
        image: null,
        role: 'USER' as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await POST(makeRequest(), makeParams());

    expect(response.status).toBe(403);
  });

  it('returns 400 for invalid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeRequest('not-a-cuid'), makeParams('not-a-cuid'));

    expect(response.status).toBe(400);
  });

  it('returns 404 when webhook does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

    const response = await POST(makeRequest(), makeParams());

    expect(response.status).toBe(404);
  });

  it('sends ping event to webhook URL and returns success', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Webhook-Event': 'ping' }),
      })
    );
    const body = await parseJson<{ data: { success: boolean; statusCode: number } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.data.success).toBe(true);
    expect(body.data.statusCode).toBe(200);
  });

  it('returns success=false when webhook URL returns 5xx', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    const response = await POST(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { success: boolean; statusCode: number } }>(response);
    expect(body.data.success).toBe(false);
    expect(body.data.statusCode).toBe(500);
  });

  it('returns error message when fetch throws', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const response = await POST(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { success: boolean; error: string } }>(response);
    expect(body.data.success).toBe(false);
    expect(body.data.error).toBe('Connection refused');
  });

  it('includes X-Webhook-Signature header in request', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await POST(makeRequest(), makeParams());

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Webhook-Signature': expect.any(String) }),
      })
    );
  });

  it('returns durationMs in response', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeRequest(), makeParams());

    const body = await parseJson<{ data: { durationMs: number } }>(response);
    expect(typeof body.data.durationMs).toBe('number');
    expect(body.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns success=false with error message when webhook has no signing secret', async () => {
    // Arrange: webhook exists but secret is null
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
      makeWebhook({ secret: null }) as never
    );

    // Act
    const response = await POST(makeRequest(), makeParams());

    // Assert: route returns 200 with success:false envelope (not 4xx) and the expected error string
    expect(response.status).toBe(200);
    const body = await parseJson<{
      data: { success: boolean; statusCode: null; durationMs: number; error: string };
    }>(response);
    expect(body.data.success).toBe(false);
    expect(body.data.statusCode).toBeNull();
    expect(body.data.error).toMatch(/no signing secret/i);
    // fetch must NOT have been called — there is nothing to send to
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns success=false with timeout error when fetch is aborted', async () => {
    // Arrange: simulate the AbortController firing by rejecting with an AbortError
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    // Act
    const response = await POST(makeRequest(), makeParams());

    // Assert: route returns 200 with the timeout-specific message
    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { success: boolean; error: string } }>(response);
    expect(body.data.success).toBe(false);
    expect(body.data.error).toMatch(/timed out/i);
  });
});
