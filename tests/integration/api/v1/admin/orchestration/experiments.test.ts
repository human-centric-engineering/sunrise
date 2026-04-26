/**
 * Integration Test: Admin Orchestration — Experiments (list + create)
 *
 * GET  /api/v1/admin/orchestration/experiments
 * POST /api/v1/admin/orchestration/experiments
 *
 * @see app/api/v1/admin/orchestration/experiments/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/experiments/route';
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
    aiExperiment: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const EXPERIMENT_ID = 'exp-1';

function makeExperiment(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPERIMENT_ID,
    name: 'Test Experiment',
    description: null,
    agentId: 'agent-1',
    status: 'draft',
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    agent: { id: 'agent-1', name: 'Test Agent', slug: 'test-agent' },
    variants: [
      { id: 'v1', label: 'Control', agentVersionId: null, evaluationSession: null },
      { id: 'v2', label: 'Variant A', agentVersionId: null, evaluationSession: null },
    ],
    creator: { id: ADMIN_ID, name: 'Admin User' },
    ...overrides,
  };
}

const VALID_BODY = {
  name: 'My Experiment',
  agentId: 'agent-1',
  variants: [{ label: 'Control' }, { label: 'Variant A' }],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/experiments');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/experiments',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/experiments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiExperiment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiExperiment.count).mockResolvedValue(0);
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

  describe('Successful listing', () => {
    it('returns paginated experiments list', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.findMany).mockResolvedValue([makeExperiment()] as never);
      vi.mocked(prisma.aiExperiment.count).mockResolvedValue(1);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: unknown[]; meta: unknown }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.meta).toBeDefined();
    });

    it('returns empty array when no experiments exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: unknown[] }>(response);
      expect(data.data).toHaveLength(0);
    });

    it('passes status filter to Prisma WHERE clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await GET(makeGetRequest({ status: 'running' }));

      expect(vi.mocked(prisma.aiExperiment.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'running' }),
        })
      );
    });
  });
});

describe('POST /api/v1/admin/orchestration/experiments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(VALID_BODY));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(VALID_BODY));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(VALID_BODY));

      expect(response.status).toBe(429);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when fewer than 2 variants are provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ ...VALID_BODY, variants: [{ label: 'A' }] }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when more than 5 variants are provided', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const tooManyVariants = Array.from({ length: 6 }, (_, i) => ({ label: `V${i}` }));

      const response = await POST(makePostRequest({ ...VALID_BODY, variants: tooManyVariants }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when name is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ ...VALID_BODY, name: undefined }));

      expect(response.status).toBe(400);
    });
  });

  describe('Successful creation', () => {
    it('creates experiment and returns 201', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.create).mockResolvedValue(makeExperiment() as never);

      const response = await POST(makePostRequest(VALID_BODY));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(EXPERIMENT_ID);
    });

    it('stores createdBy from session user id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.create).mockResolvedValue(makeExperiment() as never);

      await POST(makePostRequest(VALID_BODY));

      expect(vi.mocked(prisma.aiExperiment.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdBy: ADMIN_ID }),
        })
      );
    });

    it('calls logAdminAction with action "experiment.create"', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.create).mockResolvedValue(makeExperiment() as never);

      await POST(makePostRequest(VALID_BODY));

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'experiment.create',
          entityType: 'experiment',
        })
      );
    });

    it('includes evaluationSession on variants in the response', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.create).mockResolvedValue(makeExperiment() as never);

      const response = await POST(makePostRequest(VALID_BODY));
      const data = await parseJson<{
        data: { variants: { evaluationSession: null }[] };
      }>(response);

      // evaluationSession must be explicitly null, not absent
      expect(data.data.variants[0]).toHaveProperty('evaluationSession', null);
      expect(data.data.variants[1]).toHaveProperty('evaluationSession', null);
    });

    it('uses consistent variant include with evaluationSession', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.create).mockResolvedValue(makeExperiment() as never);

      await POST(makePostRequest(VALID_BODY));

      expect(vi.mocked(prisma.aiExperiment.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            variants: {
              include: {
                evaluationSession: { select: { id: true, status: true, completedAt: true } },
              },
            },
          }),
        })
      );
    });
  });
});
