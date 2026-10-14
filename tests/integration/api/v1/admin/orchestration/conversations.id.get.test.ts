/**
 * Integration Test: Admin Orchestration — Single Conversation (GET)
 *
 * GET /api/v1/admin/orchestration/conversations/:id
 *
 * @see app/api/v1/admin/orchestration/conversations/[id]/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Returns conversation with agent and _count includes
 * - Cross-user access returns 404 (NOT 403)
 * - Bad CUID returns 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/conversations/[id]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ────────────────────────────────────────────────────────

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
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// Black-box the access helper — its internals have their own tests
// (`tests/unit/lib/orchestration/access/conversation-access.test.ts`).
// The real `where` fragments (pure), with only the per-row check mocked.
vi.mock('@/lib/orchestration/access/conversation-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/access/conversation-access')>()),
  adminCanViewConversation: vi.fn(),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logConversationAccess: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminCanViewConversation } from '@/lib/orchestration/access/conversation-access';
import { logConversationAccess } from '@/lib/orchestration/audit/admin-audit-logger';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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
    agent: { id: AGENT_ID, name: 'Test Agent', slug: 'test-agent' },
    _count: { messages: 5 },
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(id: string): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/conversations/${id}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/conversations/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(CONV_ID), makeParams(CONV_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(CONV_ID), makeParams(CONV_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns conversation detail with agent and _count when caller owns it', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: ADMIN_ID,
      });
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as never);

      const response = await GET(makeRequest(CONV_ID), makeParams(CONV_ID));
      const data = await parseJson<{
        success: boolean;
        data: {
          id: string;
          title: string;
          agent: { id: string; name: string; slug: string };
          _count: { messages: number };
        };
      }>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(CONV_ID);
      expect(data.data.title).toBe('Test Conversation');
      expect(data.data.agent.slug).toBe('test-agent');
      expect(data.data._count.messages).toBe(5);
    });

    it('owner reads do not write an audit row (helper no-ops on basis=owner)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: ADMIN_ID,
      });
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConversation() as never);

      await GET(makeRequest(CONV_ID), makeParams(CONV_ID));

      // We DO call logConversationAccess — the helper itself decides
      // whether to write the row (it no-ops on owner). Assert the
      // route passed basis='owner' so that contract holds.
      expect(vi.mocked(logConversationAccess)).toHaveBeenCalledWith(
        expect.objectContaining({ accessBasis: 'owner' })
      );
    });

    it('shared-basis reads return 200 and audit with accessBasis=shared + conversationOwnerId', async () => {
      const OTHER_USER = 'cmjbv4i3x00003wsloputgw99';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'shared',
        ownerId: OTHER_USER,
      });
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({ userId: OTHER_USER }) as never
      );

      const response = await GET(makeRequest(CONV_ID), makeParams(CONV_ID));

      expect(response.status).toBe(200);
      expect(vi.mocked(logConversationAccess)).toHaveBeenCalledWith(
        expect.objectContaining({
          accessBasis: 'shared',
          conversationOwnerId: OTHER_USER,
          action: 'conversation.metadata_viewed',
        })
      );
    });
  });

  describe('Cross-user access (consent-gated — must be 404, not 403)', () => {
    it('returns 404 when the helper denies access (no share + non-owner)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: false,
        basis: null,
        ownerId: null,
      });

      const response = await GET(makeRequest(CONV_ID), makeParams(CONV_ID));

      expect(response.status).toBe(404);
      expect(response.status).not.toBe(403);
    });

    it('does not write an audit row when access is denied', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: false,
        basis: null,
        ownerId: null,
      });

      await GET(makeRequest(CONV_ID), makeParams(CONV_ID));

      expect(vi.mocked(logConversationAccess)).not.toHaveBeenCalled();
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(INVALID_ID), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });
});
