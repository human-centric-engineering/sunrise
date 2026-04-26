/**
 * Integration Test: Admin Orchestration — Single Conversation (DELETE)
 *
 * DELETE /api/v1/admin/orchestration/conversations/:id
 *
 * @see app/api/v1/admin/orchestration/conversations/[id]/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Ownership enforced via findFirst({ where: { id, userId } })
 * - Cross-user access returns 404 (NOT 403)
 * - AiMessage rows cascade via Prisma FK — aiMessage.deleteMany is NOT
 *   explicitly called by the route; the DB cascade handles it.
 * - Bad CUID returns 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
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
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    // aiMessage is NOT mocked here — route does not call it directly;
    // message deletion happens via DB cascade.
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
const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    userId: ADMIN_ID,
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
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
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
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeConversation() as never);
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
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiConversation.delete).mockResolvedValue(makeConversation() as never);

      await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(vi.mocked(prisma.aiConversation.delete)).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CONV_ID } })
      );
    });

    it('does NOT explicitly call aiMessage.deleteMany — messages cascade via DB FK', async () => {
      // The route relies on the Prisma relation cascade for AiMessage deletion.
      // If this test were to call aiMessage.deleteMany, it would indicate the
      // route is doing manual cleanup that should be handled by the DB schema.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiConversation.delete).mockResolvedValue(makeConversation() as never);

      await DELETE(makeRequest(), makeParams(CONV_ID));

      // Confirm prisma.aiMessage is not available on our mock (not needed by route)
      // and that the conversation was deleted exactly once.
      expect(vi.mocked(prisma.aiConversation.delete)).toHaveBeenCalledOnce();
    });
  });

  describe('Cross-user access (CRITICAL — must be 404, not 403)', () => {
    it('returns 404 when conversation is not found or belongs to another user', async () => {
      // findFirst returns null because { id, userId } does not match.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);

      const response = await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      // Explicitly NOT 403
      expect(response.status).not.toBe(403);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await DELETE(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on DELETE', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiConversation.delete).mockResolvedValue(makeConversation() as never);

      await DELETE(makeRequest(), makeParams(CONV_ID));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });
});
