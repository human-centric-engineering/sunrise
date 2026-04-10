/**
 * Integration Test: Admin Orchestration — Conversations List
 *
 * GET /api/v1/admin/orchestration/conversations
 *
 * @see app/api/v1/admin/orchestration/conversations/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Results are ALWAYS scoped to session.user.id (per-user isolation).
 *   Admins see only their own conversations — no cross-user audit view.
 * - Optional filters (agentId, isActive, q) are passed to the WHERE clause
 *   in addition to the mandatory userId scope.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/conversations/route';
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
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';

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
    _count: { messages: 5 },
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/conversations');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Per-user scoping (CRITICAL)', () => {
    it('always passes userId: session.user.id in WHERE clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest());

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID }),
        })
      );
      expect(vi.mocked(prisma.aiConversation.count)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID }),
        })
      );
    });
  });

  describe('Successful listing', () => {
    it('returns paginated conversations list for admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([
        makeConversation(),
        makeConversation({ id: 'cmjbv4i3x00003wsloputgwu4' }),
      ] as never);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(2);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: unknown[]; meta: unknown }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
      expect(data.meta).toBeDefined();
    });

    it('returns empty array when admin has no conversations', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: unknown[] }>(response);
      expect(data.data).toHaveLength(0);
    });
  });

  describe('Filtering (all filters must also include userId scope)', () => {
    it('passes agentId filter combined with userId scope', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ agentId: AGENT_ID }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID, agentId: AGENT_ID }),
        })
      );
    });

    it('passes isActive=true (string) as boolean true in WHERE clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ isActive: 'true' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID, isActive: true }),
        })
      );
    });

    it('passes isActive=false (string) as boolean false in WHERE clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ isActive: 'false' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID, isActive: false }),
        })
      );
    });

    it('passes title search q combined with userId scope', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'test chat' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: ADMIN_ID,
            title: expect.objectContaining({ contains: 'test chat' }),
          }),
        })
      );
    });
  });

  describe('Pagination', () => {
    it('applies page and limit to skip/take', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ page: '2', limit: '5' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 })
      );
    });
  });
});
