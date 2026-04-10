/**
 * Integration Test: Admin Orchestration — Clear Conversations
 *
 * POST /api/v1/admin/orchestration/conversations/clear
 *
 * @see app/api/v1/admin/orchestration/conversations/clear/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Empty body rejected by Zod refine (at least one filter required) — CRITICAL
 *   safety net preventing accidental "delete all conversations" calls.
 * - WHERE clause always includes userId: session.user.id — admins cannot
 *   clear other users' conversations.
 * - olderThan filter adds createdAt: { lt: Date } to WHERE clause.
 * - agentId filter adds agentId to WHERE clause.
 * - deleteMany is called (not single delete).
 * - Response contains deletedCount.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/conversations/clear/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/conversations/clear',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/conversations/clear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest({ agentId: AGENT_ID }));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest({ agentId: AGENT_ID }));

      expect(response.status).toBe(403);
    });
  });

  describe('CRITICAL safety net — empty body rejected', () => {
    it('returns 400 when body is completely empty (Zod refine guard)', async () => {
      // This is the most important test in this file. An empty body would
      // delete ALL of the admin's conversations — the Zod refine must block it.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({}));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when both olderThan and agentId are explicitly undefined', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ olderThan: undefined, agentId: undefined }));

      expect(response.status).toBe(400);
    });
  });

  describe('Successful clear with olderThan filter', () => {
    it('returns 200 with deletedCount when olderThan is provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 3 });

      const response = await POST(makePostRequest({ olderThan: '2025-01-01T00:00:00Z' }));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { deletedCount: number } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.deletedCount).toBe(3);
    });

    it('WHERE clause includes userId and createdAt.lt when olderThan provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 2 });

      await POST(makePostRequest({ olderThan: '2025-01-01T00:00:00Z' }));

      expect(vi.mocked(prisma.aiConversation.deleteMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: ADMIN_ID,
            createdAt: expect.objectContaining({ lt: expect.any(Date) }),
          }),
        })
      );
    });
  });

  describe('Successful clear with agentId filter', () => {
    it('returns 200 with deletedCount when agentId is provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 1 });

      const response = await POST(makePostRequest({ agentId: AGENT_ID }));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { deletedCount: number } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.deletedCount).toBe(1);
    });

    it('WHERE clause includes userId and agentId when agentId is provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 1 });

      await POST(makePostRequest({ agentId: AGENT_ID }));

      expect(vi.mocked(prisma.aiConversation.deleteMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID, agentId: AGENT_ID }),
        })
      );
    });
  });

  describe('deleteMany verification', () => {
    it('calls deleteMany (not single delete) when processing the request', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 5 });

      await POST(makePostRequest({ agentId: AGENT_ID }));

      expect(vi.mocked(prisma.aiConversation.deleteMany)).toHaveBeenCalledOnce();
    });

    it('returns deletedCount of 0 when no conversations matched filters', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 0 });

      const response = await POST(makePostRequest({ agentId: AGENT_ID }));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { deletedCount: number } }>(response);
      expect(data.data.deletedCount).toBe(0);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 0 });

      await POST(makePostRequest({ agentId: AGENT_ID }));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });
});
