/**
 * Integration Test: Admin Orchestration — Conversations List
 *
 * GET /api/v1/admin/orchestration/conversations
 *
 * @see app/api/v1/admin/orchestration/conversations/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Returns all conversations by default (cross-user admin audit)
 * - Optional userId filter scopes to a specific user
 * - Optional filters (agentId, isActive, q, dateFrom, dateTo) work correctly
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
const USER_ID = 'cmjbv4i3x00003wsloputgwu5';

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

  describe('Cross-user admin audit', () => {
    it('does not include userId in WHERE by default (shows all users)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest());

      const call = vi.mocked(prisma.aiConversation.findMany).mock.calls[0][0];
      expect(call?.where).not.toHaveProperty('userId');
    });

    it('scopes to specific user when userId param is provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ userId: USER_ID }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER_ID }),
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

    it('returns empty array when no conversations exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: unknown[] }>(response);
      expect(data.data).toHaveLength(0);
    });
  });

  describe('Filtering', () => {
    it('passes agentId filter', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ agentId: AGENT_ID }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ agentId: AGENT_ID }),
        })
      );
    });

    it('passes isActive=true (string) as boolean true', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ isActive: 'true' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        })
      );
    });

    it('passes isActive=false (string) as boolean false', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ isActive: 'false' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: false }),
        })
      );
    });

    it('passes title search q', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'test chat' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            title: expect.objectContaining({ contains: 'test chat' }),
          }),
        })
      );
    });

    it('passes messageSearch as message content filter', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ messageSearch: 'error handling' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            messages: {
              some: { content: { contains: 'error handling', mode: 'insensitive' } },
            },
          }),
        })
      );
    });

    it('applies both q and messageSearch when both provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'support', messageSearch: 'error' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            title: expect.objectContaining({ contains: 'support' }),
            messages: {
              some: { content: { contains: 'error', mode: 'insensitive' } },
            },
          }),
        })
      );
    });

    it('passes dateFrom as gte filter on updatedAt', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest({ dateFrom: '2025-01-01T00:00:00Z' }));

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            updatedAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        })
      );
    });
  });

  describe('Agent relation included', () => {
    it('includes agent select and message count in query', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);

      await GET(makeGetRequest());

      expect(vi.mocked(prisma.aiConversation.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            agent: { select: { id: true, name: true, slug: true } },
            _count: { select: { messages: true } },
          },
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
