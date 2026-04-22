/**
 * Integration Test: Admin Orchestration Agents (list + create)
 *
 * GET  /api/v1/admin/orchestration/agents
 * POST /api/v1/admin/orchestration/agents
 *
 * @see app/api/v1/admin/orchestration/agents/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/agents/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { Prisma } from '@prisma/client';

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
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    aiCostLog: {
      groupBy: vi.fn(),
    },
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  getMonthToDateGlobalSpend: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    systemInstructions: 'You are a helpful assistant.',
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
    _count: { capabilities: 0, conversations: 0 },
    _budget: null,
    ...overrides,
  };
}

const VALID_AGENT = {
  name: 'Test Agent',
  slug: 'test-agent',
  description: 'A test agent for integration tests',
  systemInstructions: 'You are a helpful assistant for testing.',
  model: 'claude-3-5-sonnet-20241022',
  provider: 'anthropic',
  temperature: 0.7,
  maxTokens: 4096,
  isActive: true,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/agents');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/agents',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(403);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    });
  });

  describe('Successful retrieval', () => {
    it('returns paginated agents list for admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const agents = [makeAgent(), makeAgent({ id: 'cmjbv4i3x00003wsloputgwu2', slug: 'agent-2' })];
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(agents as never);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(2);
      vi.mocked(prisma.aiCostLog.groupBy).mockResolvedValue([] as never);
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null as never);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: Array<{ _count: unknown; _budget: unknown }>;
        meta: unknown;
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
      expect(data.meta).toBeDefined();
      expect(data.data[0]).toHaveProperty('_count');
      expect(data.data[0]).toHaveProperty('_budget');
    });

    it('returns empty array when no agents exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: unknown[] }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(0);
    });
  });

  describe('Filtering', () => {
    it('passes isActive filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      await GET(makeGetRequest({ isActive: 'true' }));

      expect(vi.mocked(prisma.aiAgent.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
          include: expect.objectContaining({
            _count: { select: { capabilities: true, conversations: true } },
          }),
        })
      );
    });

    it('passes provider filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      await GET(makeGetRequest({ provider: 'openai' }));

      expect(vi.mocked(prisma.aiAgent.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ provider: 'openai' }),
          include: expect.objectContaining({
            _count: { select: { capabilities: true, conversations: true } },
          }),
        })
      );
    });

    it('passes search query as OR filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'support' }));

      expect(vi.mocked(prisma.aiAgent.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
          include: expect.objectContaining({
            _count: { select: { capabilities: true, conversations: true } },
          }),
        })
      );
    });
  });
});

describe('POST /api/v1/admin/orchestration/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(VALID_AGENT));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(VALID_AGENT));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST (mutating route)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.create).mockResolvedValue(makeAgent() as never);

      await POST(makePostRequest(VALID_AGENT));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });

    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(VALID_AGENT));

      expect(response.status).toBe(429);
    });
  });

  describe('Successful creation', () => {
    it('creates agent and returns 201', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const created = makeAgent();
      vi.mocked(prisma.aiAgent.create).mockResolvedValue(created as never);

      const response = await POST(makePostRequest(VALID_AGENT));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: unknown }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toMatchObject({ slug: 'test-agent' });
    });

    it('stores createdBy from session user id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.create).mockResolvedValue(makeAgent() as never);

      await POST(makePostRequest(VALID_AGENT));

      expect(vi.mocked(prisma.aiAgent.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdBy: ADMIN_ID }),
        })
      );
    });
  });

  describe('Validation errors', () => {
    it('returns 400 for missing required fields', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({}));

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 for invalid slug format', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ ...VALID_AGENT, slug: 'INVALID SLUG!' }));

      expect(response.status).toBe(400);
    });
  });

  describe('Conflict errors', () => {
    it('returns 409 when slug already exists (P2002)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiAgent.create).mockRejectedValue(p2002);

      const response = await POST(makePostRequest(VALID_AGENT));

      expect(response.status).toBe(409);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    });
  });
});
