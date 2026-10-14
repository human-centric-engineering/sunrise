/**
 * Integration Test: Admin Orchestration — Single Conversation (DELETE)
 *
 * DELETE /api/v1/admin/orchestration/conversations/:id
 *
 * @see app/api/v1/admin/orchestration/conversations/[id]/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limiting enforced by proxy.ts (orchestration tier)
 * - Access enforced via `adminCanViewConversation`: the owner may delete, and
 *   so may any admin when nobody owns the row (an inbound thread — see #502);
 *   a merely-shared conversation may not, because a share grants view consent
 *   only.
 * - Another admin's conversation returns 404 (NOT 403)
 * - AiMessage rows cascade via Prisma FK — aiMessage.deleteMany is NOT
 *   explicitly called by the route; the DB cascade handles it.
 * - Bad CUID returns 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { DELETE } from '@/app/api/v1/admin/orchestration/conversations/[id]/route';
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
      // `findUnique` serves both the access check and the title lookup the
      // audit row needs; the fixture below satisfies both shapes.
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    // Deleting someone else's inbound thread is audit-logged, so the logger's
    // table has to exist on the mock.
    aiAdminAuditLog: { create: vi.fn().mockResolvedValue({}) },
    // aiMessage is NOT mocked here — route does not call it directly;
    // message deletion happens via DB cascade.
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    userId: ADMIN_ID,
    share: null,
    agentId: AGENT_ID,
    title: 'Test Conversation',
    isActive: true,
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return {
    method: 'DELETE',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/conversations/${CONV_ID}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/admin/orchestration/conversations/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful deletion', () => {
    it('deletes conversation and returns 200 with deleted: true', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiConversation.delete).mockResolvedValue(makeConversation() as never);

      const response = await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { deleted: boolean } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.deleted).toBe(true);
    });

    it('calls aiConversation.delete with the correct id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiConversation.delete).mockResolvedValue(makeConversation() as never);

      await DELETE(makeRequest(), makeParams(CONV_ID));

      // Narrowed to the bases a delete admits (own, or nobody's), so the
      // owner layer sees the returned row confined.
      expect(vi.mocked(prisma.aiConversation.delete)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CONV_ID, AND: [{ OR: [{ userId: ADMIN_ID }, { userId: null }] }] },
        })
      );
    });

    it('does NOT explicitly call aiMessage.deleteMany — messages cascade via DB FK', async () => {
      // The route relies on the Prisma relation cascade for AiMessage deletion.
      // If this test were to call aiMessage.deleteMany, it would indicate the
      // route is doing manual cleanup that should be handled by the DB schema.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiConversation.delete).mockResolvedValue(makeConversation() as never);

      await DELETE(makeRequest(), makeParams(CONV_ID));

      // Confirm prisma.aiMessage is not available on our mock (not needed by route)
      // and that the conversation was deleted exactly once.
      expect(vi.mocked(prisma.aiConversation.delete)).toHaveBeenCalledOnce();
    });
  });

  describe('Cross-user access (CRITICAL — must be 404, not 403)', () => {
    it('returns 404 when the conversation does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null);

      const response = await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      // Explicitly NOT 403
      expect(response.status).not.toBe(403);
    });

    it('returns 404 when the conversation belongs to another admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({ userId: 'cmjbv4i3x00003wsloputgwu9' }) as never
      );

      const response = await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      expect(vi.mocked(prisma.aiConversation.delete)).not.toHaveBeenCalled();
    });

    it('returns 404 for a conversation shared with the caller — a view grant is not a destroy grant', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({
          userId: 'cmjbv4i3x00003wsloputgwu9',
          share: { revokedAt: null, expiresAt: null },
        }) as never
      );

      const response = await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      expect(vi.mocked(prisma.aiConversation.delete)).not.toHaveBeenCalled();
    });

    it('returns 404 and logs nothing when the row goes between the check and the delete', async () => {
      // The access check passes on an inbound thread; by the delete, another
      // request has removed it. The narrowed delete misses (P2025), which the
      // shared handler answers as 404 — and no audit row claims a deletion.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({ userId: null }) as never
      );
      vi.mocked(prisma.aiConversation.delete).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: '7.0.0',
        })
      );

      const response = await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      expect(vi.mocked(prisma.aiAdminAuditLog.create)).not.toHaveBeenCalled();
    });
  });

  describe('System-owned inbound threads (#502)', () => {
    it('lets any admin delete a conversation nobody owns, and records who did', async () => {
      // An inbound SMS/WhatsApp/email thread carries `userId: null`. Nobody
      // can be its owner, so an owner-only rule would make it permanently
      // undeletable — including when the person who sent the messages asks
      // for them to go. They have no account, so `eraseUser()` cannot reach
      // this row; this route is the only path there is.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({ userId: null, title: 'sms:+12133734253' }) as never
      );
      vi.mocked(prisma.aiConversation.delete).mockResolvedValue(makeConversation() as never);

      const response = await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(200);
      // Narrowed to the bases a delete admits (own, or nobody's), so the
      // owner layer sees the returned row confined.
      expect(vi.mocked(prisma.aiConversation.delete)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CONV_ID, AND: [{ OR: [{ userId: ADMIN_ID }, { userId: null }] }] },
        })
      );
      // Destroying a third party's correspondence is never routine
      // self-service: it leaves an audit row naming the admin and the basis.
      expect(vi.mocked(prisma.aiAdminAuditLog.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'conversation.deleted',
            userId: ADMIN_ID,
            metadata: expect.objectContaining({ accessBasis: 'system' }),
          }),
        })
      );
    });

    it('writes no audit row when an admin deletes their own conversation', async () => {
      // Self-access is deliberately unlogged — see `logConversationAccess`.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiConversation.delete).mockResolvedValue(makeConversation() as never);

      await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(vi.mocked(prisma.aiAdminAuditLog.create)).not.toHaveBeenCalled();
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await DELETE(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });
});
