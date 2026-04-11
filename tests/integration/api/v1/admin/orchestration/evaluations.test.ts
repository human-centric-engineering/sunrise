/**
 * Integration Test: Admin Orchestration — Evaluations List + Create
 *
 * GET  /api/v1/admin/orchestration/evaluations
 * POST /api/v1/admin/orchestration/evaluations
 *
 * @see app/api/v1/admin/orchestration/evaluations/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - GET: results ALWAYS scoped to session.user.id
 * - GET: optional filters (agentId, status, q) applied alongside userId scope
 * - POST: rate limited (adminLimiter)
 * - POST: 404 when agent doesn't exist (agents are shared admin-wide)
 * - POST: 400 on invalid body (missing title)
 * - POST: 201 on success
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/evaluations/route';
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
    aiEvaluationSession: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    aiAgent: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const SESSION_ID = 'cmjbv4i3x00003wsloputgwu3';

function makeEvaluationSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: ADMIN_ID,
    agentId: AGENT_ID,
    title: 'Test Evaluation',
    description: null,
    status: 'draft',
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    agent: { id: AGENT_ID, name: 'Test Agent', slug: 'test-agent' },
    _count: { logs: 0 },
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/evaluations');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/evaluations',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/evaluations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
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
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(0);

      await GET(makeGetRequest());

      expect(vi.mocked(prisma.aiEvaluationSession.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID }),
        })
      );
      expect(vi.mocked(prisma.aiEvaluationSession.count)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID }),
        })
      );
    });
  });

  describe('Successful listing', () => {
    it('returns paginated evaluations list for admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([
        makeEvaluationSession(),
      ] as never);
      vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(1);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: unknown[]; meta: unknown }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.meta).toBeDefined();
    });

    it('returns empty array when admin has no evaluations', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(0);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: unknown[] }>(response);
      expect(data.data).toHaveLength(0);
    });
  });

  describe('Filtering', () => {
    it('passes agentId filter combined with userId scope', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(0);

      await GET(makeGetRequest({ agentId: AGENT_ID }));

      expect(vi.mocked(prisma.aiEvaluationSession.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID, agentId: AGENT_ID }),
        })
      );
    });

    it('passes status filter combined with userId scope', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(0);

      await GET(makeGetRequest({ status: 'draft' }));

      expect(vi.mocked(prisma.aiEvaluationSession.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID, status: 'draft' }),
        })
      );
    });

    it('passes title search q combined with userId scope', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'my eval' }));

      expect(vi.mocked(prisma.aiEvaluationSession.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: ADMIN_ID,
            title: expect.objectContaining({ contains: 'my eval' }),
          }),
        })
      );
    });
  });
});

describe('POST /api/v1/admin/orchestration/evaluations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest({ agentId: AGENT_ID, title: 'My Eval' }));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest({ agentId: AGENT_ID, title: 'My Eval' }));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful creation', () => {
    it('returns 201 with the created evaluation session', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiEvaluationSession.create).mockResolvedValue(
        makeEvaluationSession() as never
      );

      const response = await POST(makePostRequest({ agentId: AGENT_ID, title: 'My Eval' }));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(SESSION_ID);
    });

    it('creates evaluation scoped to session.user.id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiEvaluationSession.create).mockResolvedValue(
        makeEvaluationSession() as never
      );

      await POST(makePostRequest({ agentId: AGENT_ID, title: 'My Eval' }));

      expect(vi.mocked(prisma.aiEvaluationSession.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: ADMIN_ID }),
        })
      );
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when title is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ agentId: AGENT_ID }));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Agent not found', () => {
    it('returns 404 when the agent does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

      const response = await POST(makePostRequest({ agentId: AGENT_ID, title: 'My Eval' }));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is hit', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest({ agentId: AGENT_ID, title: 'My Eval' }));

      expect(response.status).toBe(429);
    });
  });
});
