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
 * - Empty body rejected by Zod refine (at least one of olderThan/agentId required) —
 *   CRITICAL safety net preventing accidental "delete all conversations" calls.
 * - Default scope is `userId: session.user.id` (caller's own conversations).
 * - Opt-in cross-user scope via `userId: <cuid>` (single user) or `allUsers: true`.
 *   `userId` and `allUsers` are mutually exclusive; `allUsers: true` alone is rejected.
 * - Cross-user deletions emit an AiAdminAuditLog entry (`conversation.bulk_clear`).
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

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
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
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const OTHER_USER_ID = 'cmjbv4i3x00003wsloputgwu3';

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

  describe('Cross-user clear (targeted userId)', () => {
    it('scopes WHERE to the supplied userId and audit-logs the bulk clear', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 4 });

      const response = await POST(makePostRequest({ userId: OTHER_USER_ID, agentId: AGENT_ID }));

      expect(response.status).toBe(200);
      expect(vi.mocked(prisma.aiConversation.deleteMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: OTHER_USER_ID, agentId: AGENT_ID }),
        })
      );
      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'conversation.bulk_clear',
          metadata: expect.objectContaining({
            scope: 'user',
            targetUserId: OTHER_USER_ID,
            deletedCount: 4,
          }),
        })
      );
    });
  });

  describe('Cross-user clear (allUsers: true)', () => {
    it('omits the userId predicate and audit-logs the bulk clear', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 12 });

      const response = await POST(
        makePostRequest({ allUsers: true, olderThan: '2025-01-01T00:00:00Z' })
      );

      expect(response.status).toBe(200);
      const where = vi.mocked(prisma.aiConversation.deleteMany).mock.calls[0][0]!.where;
      expect(where).not.toHaveProperty('userId');
      expect(where).toHaveProperty('createdAt');
      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'conversation.bulk_clear',
          metadata: expect.objectContaining({ scope: 'all', deletedCount: 12 }),
        })
      );
    });

    it('returns 400 when allUsers:true has no narrowing filter', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ allUsers: true }));

      expect(response.status).toBe(400);
      expect(vi.mocked(prisma.aiConversation.deleteMany)).not.toHaveBeenCalled();
    });

    it('returns 400 when userId and allUsers are both set', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makePostRequest({
          userId: OTHER_USER_ID,
          allUsers: true,
          agentId: AGENT_ID,
        })
      );

      expect(response.status).toBe(400);
    });
  });

  describe('Self-scoped clear emits audit log', () => {
    it('calls logAdminAction with scope "self" for self-scoped clear', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 1 });

      await POST(makePostRequest({ agentId: AGENT_ID }));

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'conversation.bulk_clear',
          entityType: 'conversation',
          metadata: expect.objectContaining({ scope: 'self' }),
        })
      );
    });
  });
});
