/**
 * Integration Test: Admin Orchestration Workflows (list + create)
 *
 * GET  /api/v1/admin/orchestration/workflows
 * POST /api/v1/admin/orchestration/workflows
 *
 * @see app/api/v1/admin/orchestration/workflows/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/workflows/route';
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

// Shared transaction-internal mocks so tests can assert on the tx writes.
const txMocks = {
  workflowCreate: vi.fn(),
  workflowUpdate: vi.fn(),
  workflowFindUniqueOrThrow: vi.fn(),
  versionCreate: vi.fn(),
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    aiWorkflowVersion: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        aiWorkflow: {
          create: txMocks.workflowCreate,
          update: txMocks.workflowUpdate,
          findUniqueOrThrow: txMocks.workflowFindUniqueOrThrow,
        },
        aiWorkflowVersion: { create: txMocks.versionCreate },
      })
    ),
  },
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

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

const VALID_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'First Step',
      type: 'llm_call',
      config: { prompt: 'Hello' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    workflowDefinition: VALID_DEFINITION,
    patternsUsed: [1, 4],
    isActive: true,
    isTemplate: false,
    metadata: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    _count: { executions: 0 },
    ...overrides,
  };
}

const VALID_WORKFLOW = {
  name: 'Test Workflow',
  slug: 'test-workflow',
  description: 'A test workflow for integration tests',
  workflowDefinition: VALID_DEFINITION,
  patternsUsed: [1],
  isActive: true,
  isTemplate: false,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/workflows');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/workflows',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  describe('Successful retrieval', () => {
    it('returns paginated workflows list', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([makeWorkflow()] as never);
      vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(1);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: Array<{ _count: { executions: number } }>;
        meta: unknown;
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.meta).toBeDefined();
      expect(data.data[0]._count.executions).toBe(0);
    });

    it('returns empty array when no workflows exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(0);

      const response = await GET(makeGetRequest());

      const data = await parseJson<{ data: unknown[] }>(response);
      expect(data.data).toHaveLength(0);
    });
  });

  describe('Filtering', () => {
    it('passes isActive filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(0);

      await GET(makeGetRequest({ isActive: 'true' }));

      expect(vi.mocked(prisma.aiWorkflow.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isActive: true }) })
      );
    });

    it('passes isTemplate filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(0);

      await GET(makeGetRequest({ isTemplate: 'true' }));

      expect(vi.mocked(prisma.aiWorkflow.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isTemplate: true }) })
      );
    });

    it('passes search query as OR filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'approval' }));

      expect(vi.mocked(prisma.aiWorkflow.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        })
      );
    });
  });
});

describe('POST /api/v1/admin/orchestration/workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(VALID_WORKFLOW));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(VALID_WORKFLOW));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(VALID_WORKFLOW));

      expect(response.status).toBe(429);
    });
  });

  describe('Successful creation', () => {
    it('creates workflow and returns 201', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // POST now wraps create + initial-version in a transaction — the
      // shared txMocks let us assert on the inner writes.
      txMocks.workflowCreate.mockResolvedValue({ id: 'wf-new' });
      txMocks.versionCreate.mockResolvedValue({ id: 'wfv-new', version: 1 });
      txMocks.workflowFindUniqueOrThrow.mockResolvedValue(makeWorkflow());

      const response = await POST(makePostRequest(VALID_WORKFLOW));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: { slug: string } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.slug).toBe('test-workflow');
      // Initial version (v1) is seeded inside the same transaction.
      expect(txMocks.versionCreate).toHaveBeenCalledOnce();
    });

    it('stores createdBy from session user id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      txMocks.workflowCreate.mockResolvedValue({ id: 'wf-new' });
      txMocks.versionCreate.mockResolvedValue({ id: 'wfv-new', version: 1 });
      txMocks.workflowFindUniqueOrThrow.mockResolvedValue(makeWorkflow());

      await POST(makePostRequest(VALID_WORKFLOW));

      expect(txMocks.workflowCreate).toHaveBeenCalledWith(
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

    it('returns 400 for workflow definition with no steps', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makePostRequest({
          ...VALID_WORKFLOW,
          workflowDefinition: { steps: [], entryStepId: 'step-1', errorStrategy: 'fail' },
        })
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid slug format', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ ...VALID_WORKFLOW, slug: 'INVALID SLUG!' }));

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
      txMocks.workflowCreate.mockRejectedValue(p2002);

      const response = await POST(makePostRequest(VALID_WORKFLOW));

      expect(response.status).toBe(409);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    });
  });
});
