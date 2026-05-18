/**
 * Integration Test: Consumer Chat — Share / revoke a conversation
 *
 * POST   /api/v1/chat/conversations/:id/share
 * DELETE /api/v1/chat/conversations/:id/share
 *
 * @see app/api/v1/chat/conversations/[id]/share/route.ts
 *
 * Key assertions:
 * - Authenticated user required (401 otherwise)
 * - Owner-only (non-owner → 404, never confirms existence)
 * - POST validates body (reason ≤500, expiresInDays 1–90)
 * - POST upserts: re-share clears revokedAt + refreshes expiresAt
 * - DELETE is idempotent: missing share / already-revoked → 200
 * - Empty POST body uses default 7-day expiry
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      findFirst: vi.fn(),
    },
    aiConversationShare: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { POST, DELETE } from '@/app/api/v1/chat/conversations/[id]/share/route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';
const SHARE_ID = 'cmjbv4i3x00003wsloputgwsh';
const INVALID_ID = 'not-a-cuid';

function postRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/chat/conversations/${CONV_ID}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '' : JSON.stringify(body),
  });
}

function deleteRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/chat/conversations/${CONV_ID}/share`, {
    method: 'DELETE',
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── POST /share ─────────────────────────────────────────────────────────────

describe('POST /api/v1/chat/conversations/:id/share', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await POST(postRequest({}), paramsFor(CONV_ID));
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid conversation id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await POST(postRequest({}), paramsFor(INVALID_ID));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the conversation does not belong to the caller', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);
    const res = await POST(postRequest({}), paramsFor(CONV_ID));
    expect(res.status).toBe(404);
    expect(prisma.aiConversationShare.upsert).not.toHaveBeenCalled();
  });

  it('upserts a share row with the default 7-day expiry when no body is provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({ id: CONV_ID } as never);
    vi.mocked(prisma.aiConversationShare.upsert).mockResolvedValue({
      id: SHARE_ID,
      conversationId: CONV_ID,
    } as never);

    const before = Date.now();
    const res = await POST(postRequest({}), paramsFor(CONV_ID));
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: { shareId: string; expiresAt: string };
    }>(res);
    expect(body.data.shareId).toBe(SHARE_ID);

    // Default expiry is ~7 days from now (±a few seconds for test latency).
    const expiresMs = new Date(body.data.expiresAt).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
  });

  it('honours an explicit expiresInDays value', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({ id: CONV_ID } as never);
    vi.mocked(prisma.aiConversationShare.upsert).mockResolvedValue({
      id: SHARE_ID,
      conversationId: CONV_ID,
    } as never);

    const before = Date.now();
    const res = await POST(postRequest({ expiresInDays: 30 }), paramsFor(CONV_ID));
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = await parseJson<{ data: { expiresAt: string } }>(res);
    const expiresMs = new Date(body.data.expiresAt).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
  });

  it('persists the user-supplied reason verbatim', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({ id: CONV_ID } as never);
    vi.mocked(prisma.aiConversationShare.upsert).mockResolvedValue({
      id: SHARE_ID,
      conversationId: CONV_ID,
    } as never);

    await POST(postRequest({ reason: 'Complaint about refund #4421' }), paramsFor(CONV_ID));

    expect(prisma.aiConversationShare.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: 'Complaint about refund #4421' }),
        update: expect.objectContaining({ reason: 'Complaint about refund #4421' }),
      })
    );
  });

  it('clears revokedAt on re-share (upsert.update path)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({ id: CONV_ID } as never);
    vi.mocked(prisma.aiConversationShare.upsert).mockResolvedValue({
      id: SHARE_ID,
      conversationId: CONV_ID,
    } as never);

    await POST(postRequest({}), paramsFor(CONV_ID));

    expect(prisma.aiConversationShare.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ revokedAt: null }),
      })
    );
  });

  it('rejects a reason longer than 500 chars', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await POST(postRequest({ reason: 'x'.repeat(501) }), paramsFor(CONV_ID));
    expect(res.status).toBe(400);
  });

  it('rejects expiresInDays = 0 (must be ≥1)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await POST(postRequest({ expiresInDays: 0 }), paramsFor(CONV_ID));
    expect(res.status).toBe(400);
  });

  it('rejects expiresInDays > 90 (cap)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await POST(postRequest({ expiresInDays: 91 }), paramsFor(CONV_ID));
    expect(res.status).toBe(400);
  });
});

// ─── DELETE /share ───────────────────────────────────────────────────────────

describe('DELETE /api/v1/chat/conversations/:id/share', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await DELETE(deleteRequest(), paramsFor(CONV_ID));
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await DELETE(deleteRequest(), paramsFor(INVALID_ID));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the conversation does not belong to the caller', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);
    const res = await DELETE(deleteRequest(), paramsFor(CONV_ID));
    expect(res.status).toBe(404);
    expect(prisma.aiConversationShare.update).not.toHaveBeenCalled();
  });

  it('sets revokedAt when an active share exists', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({ id: CONV_ID } as never);
    vi.mocked(prisma.aiConversationShare.findUnique).mockResolvedValue({
      id: SHARE_ID,
      revokedAt: null,
    } as never);
    vi.mocked(prisma.aiConversationShare.update).mockResolvedValue({} as never);

    const res = await DELETE(deleteRequest(), paramsFor(CONV_ID));

    expect(res.status).toBe(200);
    const body = await parseJson<{ data: { revoked: boolean } }>(res);
    expect(body.data.revoked).toBe(true);
    expect(prisma.aiConversationShare.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: CONV_ID },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      })
    );
  });

  it('is idempotent: revoking a missing share returns 200 with revoked=false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({ id: CONV_ID } as never);
    vi.mocked(prisma.aiConversationShare.findUnique).mockResolvedValue(null);

    const res = await DELETE(deleteRequest(), paramsFor(CONV_ID));

    expect(res.status).toBe(200);
    const body = await parseJson<{ data: { revoked: boolean } }>(res);
    expect(body.data.revoked).toBe(false);
    expect(prisma.aiConversationShare.update).not.toHaveBeenCalled();
  });

  it('is idempotent: revoking an already-revoked share returns 200 with revoked=false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue({ id: CONV_ID } as never);
    vi.mocked(prisma.aiConversationShare.findUnique).mockResolvedValue({
      id: SHARE_ID,
      revokedAt: new Date(),
    } as never);

    const res = await DELETE(deleteRequest(), paramsFor(CONV_ID));

    expect(res.status).toBe(200);
    const body = await parseJson<{ data: { revoked: boolean } }>(res);
    expect(body.data.revoked).toBe(false);
    expect(prisma.aiConversationShare.update).not.toHaveBeenCalled();
  });
});
