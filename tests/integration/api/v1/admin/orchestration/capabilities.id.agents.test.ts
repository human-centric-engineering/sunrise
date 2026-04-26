/**
 * Integration Test: Admin Orchestration — Capability → Agents Reverse Lookup
 *
 * GET /api/v1/admin/orchestration/capabilities/:id/agents
 *   Returns minimal agent projections for every agent that has this
 *   capability attached via the AiAgentCapability pivot.
 *
 * @see app/api/v1/admin/orchestration/capabilities/[id]/agents/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/capabilities/[id]/agents/route';
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
    aiCapability: { findUnique: vi.fn() },
    aiAgentCapability: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CAPABILITY_ID = 'cmjbv4i3x00003wsloputgwul';
const AGENT_ID_1 = 'cmjbv4i3x00003wsloputgwu2';
const AGENT_ID_2 = 'cmjbv4i3x00003wsloputgwu3';

function makeCapability() {
  return { id: CAPABILITY_ID };
}

function makeAgent(id: string, name: string) {
  return { id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), isActive: true };
}

function makeLink(agentId: string, agentName: string) {
  return {
    id: `link-${agentId}`,
    agentId,
    capabilityId: CAPABILITY_ID,
    isEnabled: true,
    customConfig: null,
    customRateLimit: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    agent: makeAgent(agentId, agentName),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(id: string): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve({}),
    url: `http://localhost:3000/api/v1/admin/orchestration/capabilities/${id}/agents`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/capabilities/:id/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── Authentication & Authorization ─────────────────────────────────────────

  describe('Authentication & Authorization', () => {
    it('returns 401 for unauthenticated requests', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(CAPABILITY_ID), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 for non-admin authenticated users', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(CAPABILITY_ID), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(403);
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  describe('Validation', () => {
    it('returns 400 for invalid CUID id param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest('not-a-cuid'), makeParams('not-a-cuid'));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
    });

    it('returns 400 for empty string id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(''), makeParams(''));

      expect(response.status).toBe(400);
    });
  });

  // ── Not found ─────────────────────────────────────────────────────────────

  describe('Not found', () => {
    it('returns 404 when capability does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(CAPABILITY_ID), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
    });
  });

  // ── Successful list ────────────────────────────────────────────────────────

  describe('Successful list', () => {
    it('returns empty array when no agents are attached', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([] as never);

      const response = await GET(makeRequest(CAPABILITY_ID), makeParams(CAPABILITY_ID));
      const data = await parseJson<{ success: boolean; data: unknown[] }>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(0);
    });

    it('returns array of minimal agent projections when agents are linked', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([
        makeLink(AGENT_ID_1, 'Alpha Bot'),
        makeLink(AGENT_ID_2, 'Beta Bot'),
      ] as never);

      const response = await GET(makeRequest(CAPABILITY_ID), makeParams(CAPABILITY_ID));
      const data = await parseJson<{
        success: boolean;
        data: { id: string; name: string; slug: string; isActive: boolean }[];
      }>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);

      const ids = data.data.map((a) => a.id);
      expect(ids).toContain(AGENT_ID_1);
      expect(ids).toContain(AGENT_ID_2);

      const names = data.data.map((a) => a.name);
      expect(names).toContain('Alpha Bot');
      expect(names).toContain('Beta Bot');
    });

    it('each agent projection has the required fields: id, name, slug, isActive', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([
        makeLink(AGENT_ID_1, 'Alpha Bot'),
      ] as never);

      const response = await GET(makeRequest(CAPABILITY_ID), makeParams(CAPABILITY_ID));
      const data = await parseJson<{
        success: boolean;
        data: { id: string; name: string; slug: string; isActive: boolean }[];
      }>(response);

      expect(response.status).toBe(200);
      const agent = data.data[0];
      expect(agent).toHaveProperty('id');
      expect(agent).toHaveProperty('name');
      expect(agent).toHaveProperty('slug');
      expect(agent).toHaveProperty('isActive');
    });

    it('calls findMany with include.agent and orderBy agent.name asc', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([] as never);

      await GET(makeRequest(CAPABILITY_ID), makeParams(CAPABILITY_ID));

      expect(vi.mocked(prisma.aiAgentCapability.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { capabilityId: CAPABILITY_ID },
          include: { agent: expect.any(Object) },
          orderBy: { agent: { name: 'asc' } },
        })
      );
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await GET(makeRequest(CAPABILITY_ID), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(429);
    });
  });
});
