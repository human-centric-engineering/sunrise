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

// The real `where` fragments (pure), with only the per-row check mocked.
vi.mock('@/lib/orchestration/access/conversation-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/access/conversation-access')>()),
  adminCanViewConversation: vi.fn(),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logConversationAccess: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminCanViewConversation } from '@/lib/orchestration/access/conversation-access';
import { logConversationAccess } from '@/lib/orchestration/audit/admin-audit-logger';

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

  describe('Successful retrieval — owner basis', () => {
    it('returns 200 with messages when caller owns the conversation', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: USER_ID,
      });
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

    it('returns messages ordered ascending by createdAt', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: USER_ID,
      });
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

  describe('Successful retrieval — shared basis (consent-gated cross-user)', () => {
    it('returns 200 when the helper grants shared-basis access', async () => {
      const OTHER_USER = 'cmjbv4i3x00003wsloputgw88';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'shared',
        ownerId: OTHER_USER,
      });
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({ userId: OTHER_USER }) as never
      );
      vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([makeMessage()] as never);

      const response = await GET(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(200);
      expect(vi.mocked(logConversationAccess)).toHaveBeenCalledWith(
        expect.objectContaining({
          accessBasis: 'shared',
          conversationOwnerId: OTHER_USER,
          action: 'conversation.messages_viewed',
        })
      );
    });
  });

  describe('Not found (consent-gated)', () => {
    it('returns 404 when the helper denies access', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: false,
        basis: null,
        ownerId: null,
      });

      const response = await GET(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      // No audit row when access is denied.
      expect(vi.mocked(logConversationAccess)).not.toHaveBeenCalled();
    });

    it('returns 404 if the conversation disappears between the access check and the data fetch (TOCTOU)', async () => {
      // Defensive belt-and-braces: the helper says ok, but the
      // subsequent findUnique returns null because the conversation was
      // deleted between the two queries (e.g. concurrent DELETE in
      // another tab). The route must 404 cleanly rather than NPE.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: USER_ID,
      });
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      // No audit row — the conversation no longer exists by the time
      // we'd record the access.
      expect(vi.mocked(logConversationAccess)).not.toHaveBeenCalled();
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
