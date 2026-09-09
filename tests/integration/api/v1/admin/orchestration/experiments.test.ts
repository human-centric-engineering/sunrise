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
import { ownerScopedCount, ownerScopedFindMany } from '@/tests/helpers/owner-scoped-prisma';

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
    aiDataset: {
      findFirst: vi.fn(),
    },
  },
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
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

    it('passes agentId filter to Prisma WHERE clause', async () => {
      // Catches a regression where the agentId branch in buildWhere is dropped.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await GET(makeGetRequest({ agentId: 'agent-42' }));

      expect(vi.mocked(prisma.aiExperiment.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ agentId: 'agent-42' }),
        })
      );
    });
  });

  /**
   * #741: this list read every admin's experiments while `run` / `compare` /
   * `verdicts` 404'd across users. The fakes below filter on `createdBy` the
   * way the database does, so removing the clause from the route turns these
   * red — a fixture containing only the caller's own rows would not.
   */
  describe('Ownership', () => {
    const OWN = makeExperiment({ id: 'exp-own', createdBy: ADMIN_ID });
    const FOREIGN = makeExperiment({ id: 'exp-foreign', createdBy: 'someone-else' });

    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.findMany).mockImplementation(
        ownerScopedFindMany([OWN, FOREIGN]) as never
      );
      vi.mocked(prisma.aiExperiment.count).mockImplementation(
        ownerScopedCount([OWN, FOREIGN]) as never
      );
    });

    it("omits another admin's experiment from the list", async () => {
      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: Array<{ id: string }> }>(response);
      expect(data.data.map((e) => e.id)).toEqual(['exp-own']);
    });

    it('counts only the rows it returns, so the total leaks no hidden ones', async () => {
      // A total computed without the owner clause reports how many rows exist
      // that the caller cannot see — and every page-level assertion still passes.
      const response = await GET(makeGetRequest());

      const data = await parseJson<{ meta: { total: number } }>(response);
      expect(data.meta.total).toBe(1);
      expect(vi.mocked(prisma.aiExperiment.count).mock.calls[0][0]).toMatchObject({
        where: { createdBy: ADMIN_ID },
      });
    });

    it('keeps the owner clause when a status filter is also applied', async () => {
      // The clause is assigned onto a literal rather than spread, so an extra
      // filter cannot overwrite it — `?createdBy=` would be the obvious way in.
      await GET(makeGetRequest({ status: 'draft' }));

      expect(vi.mocked(prisma.aiExperiment.findMany).mock.calls[0][0]).toMatchObject({
        where: { createdBy: ADMIN_ID, status: 'draft' },
      });
    });
  });
});

describe('POST /api/v1/admin/orchestration/experiments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
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

    it('stores description when provided', async () => {
      // Catches a regression where the description field is silently dropped from
      // the create data even when the caller supplies it.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiExperiment.create).mockResolvedValue(
        makeExperiment({ description: 'Hypothesis: more context improves recall' }) as never
      );

      await POST(
        makePostRequest({ ...VALID_BODY, description: 'Hypothesis: more context improves recall' })
      );

      expect(vi.mocked(prisma.aiExperiment.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            description: 'Hypothesis: more context improves recall',
          }),
        })
      );
    });

    it('stores agentVersionId on variants when provided', async () => {
      // Catches a regression where agentVersionId is stripped from variant create data.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const experimentWithVersions = makeExperiment({
        variants: [
          { id: 'v1', label: 'Control', agentVersionId: 'ver-1', evaluationSession: null },
          { id: 'v2', label: 'Variant A', agentVersionId: null, evaluationSession: null },
        ],
      });
      vi.mocked(prisma.aiExperiment.create).mockResolvedValue(experimentWithVersions as never);

      const bodyWithVersionId = {
        ...VALID_BODY,
        variants: [{ label: 'Control', agentVersionId: 'ver-1' }, { label: 'Variant A' }],
      };
      await POST(makePostRequest(bodyWithVersionId));

      expect(vi.mocked(prisma.aiExperiment.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            variants: {
              create: expect.arrayContaining([
                expect.objectContaining({ label: 'Control', agentVersionId: 'ver-1' }),
              ]),
            },
          }),
        })
      );
    });
  });

  describe('Dataset-driven creation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns 201 when datasetId is provided with metricConfigs and dataset is owned by caller', async () => {
      // Catches a regression where the dataset ownership check is bypassed and
      // aiDataset.findFirst is called without the userId filter.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: 'ds-1' } as never);
      vi.mocked(prisma.aiExperiment.create).mockResolvedValue(makeExperiment() as never);

      const body = {
        ...VALID_BODY,
        datasetId: 'ds-1',
        metricConfigs: [{ slug: 'faithfulness' }],
      };
      const response = await POST(makePostRequest(body));

      expect(response.status).toBe(201);
      // Verify the ownership filter was applied: userId must equal the session user
      expect(vi.mocked(prisma.aiDataset.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'ds-1', userId: ADMIN_ID }),
        })
      );
    });

    it('returns 404 when datasetId points to a dataset owned by a different user', async () => {
      // Catches a regression where findFirst returns null (cross-user or missing)
      // but the handler proceeds instead of throwing NotFoundError.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null);

      const body = {
        ...VALID_BODY,
        datasetId: 'ds-foreign',
        metricConfigs: [{ slug: 'faithfulness' }],
      };
      const response = await POST(makePostRequest(body));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      // create must NOT be called when the dataset check fails
      expect(vi.mocked(prisma.aiExperiment.create)).not.toHaveBeenCalled();
    });

    it('returns 400 when datasetId is provided but metricConfigs is absent', async () => {
      // Exercises the Zod .refine() that enforces "metricConfigs is required when
      // datasetId is set". If the refine is ever removed or misplaced, experiment
      // creation would silently skip metric scoring setup.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const body = {
        ...VALID_BODY,
        datasetId: 'ds-1',
        // metricConfigs intentionally absent
      };
      const response = await POST(makePostRequest(body));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
