/**
 * Integration Test: Admin Orchestration Agent Instructions History
 *
 * GET /api/v1/admin/orchestration/agents/:id/instructions-history
 *
 * Returns current systemInstructions + history parsed from JSON, newest first.
 * Malformed history JSON is handled gracefully (returns empty array).
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/instructions-history/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/agents/[id]/instructions-history/route';
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
    aiAgent: {
      findUnique: vi.fn(),
    },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeAgentWithHistory(
  historyEntries: Array<{ instructions: string; changedAt: string; changedBy: string }>
) {
  return {
    id: AGENT_ID,
    slug: 'test-agent',
    systemInstructions: 'Current instructions.',
    systemInstructionsHistory: historyEntries,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/instructions-history`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/agents/:id/instructions-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns agentId, slug, current instructions, and history', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentWithHistory([]) as never);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: {
          agentId: string;
          slug: string;
          current: string;
          history: unknown[];
        };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.agentId).toBe(AGENT_ID);
      expect(data.data.slug).toBe('test-agent');
      expect(data.data.current).toBe('Current instructions.');
      expect(Array.isArray(data.data.history)).toBe(true);
    });

    it('returns history in newest-first order', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const entries = [
        {
          instructions: 'Oldest instructions.',
          changedAt: '2025-01-01T00:00:00.000Z',
          changedBy: ADMIN_ID,
        },
        {
          instructions: 'Middle instructions.',
          changedAt: '2025-02-01T00:00:00.000Z',
          changedBy: ADMIN_ID,
        },
        {
          instructions: 'Newest stored instructions.',
          changedAt: '2025-03-01T00:00:00.000Z',
          changedBy: ADMIN_ID,
        },
      ];
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgentWithHistory(entries) as never
      );

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      const data = await parseJson<{
        data: { history: Array<{ instructions: string; changedAt: string }> };
      }>(response);

      // History should be reversed: newest first
      expect(data.data.history[0].instructions).toBe('Newest stored instructions.');
      expect(data.data.history[1].instructions).toBe('Middle instructions.');
      expect(data.data.history[2].instructions).toBe('Oldest instructions.');
    });

    it('returns empty history array when no history exists', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentWithHistory([]) as never);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      const data = await parseJson<{ data: { history: unknown[] } }>(response);
      expect(data.data.history).toHaveLength(0);
    });

    it('returns empty history array when stored JSON is malformed', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // Malformed: not an array of valid entries
      const agentWithBadHistory = {
        id: AGENT_ID,
        slug: 'test-agent',
        systemInstructions: 'Current instructions.',
        systemInstructionsHistory: 'this-is-not-an-array',
      };
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(agentWithBadHistory as never);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: { history: unknown[] } }>(response);
      expect(data.data.history).toHaveLength(0);
    });
  });

  describe('Error cases', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(), makeParams('not-a-cuid'));

      expect(response.status).toBe(400);
    });

    it('returns 404 when agent not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(404);
    });
  });
});
