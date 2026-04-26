/**
 * Integration Test: Admin Orchestration — Conversation Messages
 *
 * GET /api/v1/admin/orchestration/conversations/:id/messages
 *
 * @see app/api/v1/admin/orchestration/conversations/[id]/messages/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Returns messages for any conversation (cross-user admin audit)
 * - Bad CUID returns 400
 * - Non-existent conversation returns 404
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
      findUnique: vi.fn(),
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

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';
const USER_ID = 'cmjbv4i3x00003wsloputgwu7';
const INVALID_ID = 'not-a-cuid';

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    userId: USER_ID,
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
    it('returns 200 with messages and conversation metadata', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as never);
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
      const data = await parseJson<{
        success: boolean;
        data: { conversation: { userId: string }; messages: unknown[] };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.messages).toHaveLength(2);
      expect(data.data.conversation.userId).toBe(USER_ID);
    });

    it('looks up conversation by id (cross-user admin audit)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([]);

      await GET(makeRequest(), makeParams(CONV_ID));

      expect(vi.mocked(prisma.aiConversation.findUnique)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CONV_ID },
        })
      );
    });

    it('returns messages ordered ascending by createdAt', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as never);
      vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([]);

      await GET(makeRequest(), makeParams(CONV_ID));

      expect(vi.mocked(prisma.aiMessage.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'asc' },
        })
      );
    });
  });

  describe('Not found', () => {
    it('returns 404 when conversation does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(404);
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
