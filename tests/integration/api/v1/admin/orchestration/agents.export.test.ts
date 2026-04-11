/**
 * Integration Test: Admin Orchestration Agents Export
 *
 * POST /api/v1/admin/orchestration/agents/export
 *   Body: { agentIds: string[] }
 *
 * Returns a versioned AgentBundle. Sets Content-Disposition: attachment header.
 * Returns 404 if any requested agent id is missing.
 *
 * @see app/api/v1/admin/orchestration/agents/export/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/agents/export/route';
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
    aiAgent: { findMany: vi.fn() },
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

const AGENT_ID_1 = 'cmjbv4i3x00003wsloputgwul';
const AGENT_ID_2 = 'cmjbv4i3x00003wsloputgwu2';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeDbAgent(id: string, slug: string) {
  return {
    id,
    name: `Agent ${slug}`,
    slug,
    description: 'Test agent description',
    systemInstructions: 'You are a test agent.',
    systemInstructionsHistory: [],
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    providerConfig: null,
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    metadata: null,
    isActive: true,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    capabilities: [],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/agents/export',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/agents/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1] }));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1] }));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST (mutating route)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
        makeDbAgent(AGENT_ID_1, 'agent-one'),
      ] as never);

      await POST(makeRequest({ agentIds: [AGENT_ID_1] }));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });

    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1] }));

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.aiAgent.findMany)).not.toHaveBeenCalled();
    });
  });

  describe('Successful export', () => {
    it('returns bundle with correct shape { success, data: { version, exportedAt, agents } }', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
        makeDbAgent(AGENT_ID_1, 'agent-one'),
      ] as never);

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1] }));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { version: string; exportedAt: string; agents: unknown[] };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.version).toBe('1');
      expect(data.data.exportedAt).toBeDefined();
      expect(Array.isArray(data.data.agents)).toBe(true);
      expect(data.data.agents).toHaveLength(1);
    });

    it('sets Content-Disposition: attachment header', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
        makeDbAgent(AGENT_ID_1, 'agent-one'),
      ] as never);

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1] }));

      const contentDisposition = response.headers.get('Content-Disposition');
      expect(contentDisposition).toBeDefined();
      expect(contentDisposition).toContain('attachment');
    });

    it('exports multiple agents', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
        makeDbAgent(AGENT_ID_1, 'agent-one'),
        makeDbAgent(AGENT_ID_2, 'agent-two'),
      ] as never);

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1, AGENT_ID_2] }));

      const data = await parseJson<{ data: { agents: unknown[] } }>(response);
      expect(data.data.agents).toHaveLength(2);
    });

    it('strips server-owned fields (id, createdAt, updatedAt, createdBy) from exported agents', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
        makeDbAgent(AGENT_ID_1, 'agent-one'),
      ] as never);

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1] }));

      const data = await parseJson<{ data: { agents: Array<Record<string, unknown>> } }>(response);
      const exportedAgent = data.data.agents[0];
      expect(exportedAgent).not.toHaveProperty('id');
      expect(exportedAgent).not.toHaveProperty('createdAt');
      expect(exportedAgent).not.toHaveProperty('updatedAt');
      expect(exportedAgent).not.toHaveProperty('createdBy');
    });

    it('exports empty history array when stored systemInstructionsHistory is malformed', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const agentWithBadHistory = {
        ...makeDbAgent(AGENT_ID_1, 'agent-one'),
        systemInstructionsHistory: 'not-an-array',
      };
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([agentWithBadHistory] as never);

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1] }));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { agents: Array<{ systemInstructionsHistory: unknown[] }> };
      }>(response);
      expect(data.data.agents[0].systemInstructionsHistory).toEqual([]);
    });

    it('exports capabilities with slug (not id)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const agentWithCap = {
        ...makeDbAgent(AGENT_ID_1, 'agent-one'),
        capabilities: [
          {
            id: 'link-id-1',
            agentId: AGENT_ID_1,
            capabilityId: 'cmjbv4i3x00003wsloputgwu3',
            isEnabled: true,
            customConfig: null,
            customRateLimit: null,
            capability: { slug: 'search-web' },
          },
        ],
      };
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([agentWithCap] as never);

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1] }));

      const data = await parseJson<{
        data: { agents: Array<{ capabilities: Array<{ slug: string }> }> };
      }>(response);
      expect(data.data.agents[0].capabilities[0].slug).toBe('search-web');
      expect(data.data.agents[0].capabilities[0]).not.toHaveProperty('id');
    });
  });

  describe('Error cases', () => {
    it('returns 404 when any requested agent id is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // Only returns one agent when two were requested
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
        makeDbAgent(AGENT_ID_1, 'agent-one'),
      ] as never);

      const response = await POST(makeRequest({ agentIds: [AGENT_ID_1, AGENT_ID_2] }));

      expect(response.status).toBe(404);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    });

    it('returns 400 for empty agentIds array', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest({ agentIds: [] }));

      expect(response.status).toBe(400);
    });

    it('returns 400 for missing agentIds', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest({}));

      expect(response.status).toBe(400);
    });
  });
});
