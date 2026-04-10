/**
 * Integration Test: Admin Orchestration — Conversation Messages
 *
 * GET /api/v1/admin/orchestration/conversations/:id/messages
 *
 * @see app/api/v1/admin/orchestration/conversations/[id]/messages/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Ownership is enforced via findFirst({ where: { id, userId } })
 * - Cross-user access returns 404 (NOT 403) — we never confirm existence
 *   of resources owned by other users.
 * - Bad CUID returns 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/conversations/[id]/messages/route';
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
    },
    aiMessage: {
      findMany: vi.fn(),
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

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmjbv4i3x00003wsloputgwu5',
    conversationId: CONV_ID,
    role: 'user',
    content: 'Hello!',
    tokenCount: null,
    costUsd: null,
    metadata: null,
    createdAt: new Date('2025-01-01T10:00:00Z'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/conversations/${CONV_ID}/messages`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/conversations/:id/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns 200 with messages for an owned conversation', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([
        makeMessage({ createdAt: new Date('2025-01-01T10:00:00Z') }),
        makeMessage({
          id: 'cmjbv4i3x00003wsloputgwu6',
          role: 'assistant',
          content: 'Hello back!',
          createdAt: new Date('2025-01-01T10:00:05Z'),
        }),
      ] as never);

      const response = await GET(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { messages: unknown[] } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.messages).toHaveLength(2);
    });

    it('queries conversation with both id and userId for ownership check', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([]);

      await GET(makeRequest(), makeParams(CONV_ID));

      expect(vi.mocked(prisma.aiConversation.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: CONV_ID, userId: ADMIN_ID }),
        })
      );
    });

    it('returns messages ordered ascending by createdAt', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([]);

      await GET(makeRequest(), makeParams(CONV_ID));

      expect(vi.mocked(prisma.aiMessage.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'asc' },
        })
      );
    });
  });

  describe('Cross-user access (CRITICAL — must be 404, not 403)', () => {
    it('returns 404 when conversation is not found or belongs to another user', async () => {
      // findFirst returns null because { id, userId } does not match.
      // This is the intended behavior: we never confirm existence of
      // resources owned by other users.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      // Explicitly NOT 403 — must not confirm the resource exists
      expect(response.status).not.toBe(403);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });
});
