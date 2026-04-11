/**
 * Integration Test: Execute workflow stub (501)
 *
 * POST /api/v1/admin/orchestration/workflows/:id/execute
 *
 * This route is a full handler that validates auth, body, workflow existence,
 * workflow activity, and DAG structure — then returns 501 NOT_IMPLEMENTED.
 * The engine arrives in Session 5.2.
 *
 * Key assertions:
 *   - Auth guard blocks unauthenticated (401)
 *   - Body validation runs (bad body → 400)
 *   - CUID validation runs (bad id → 400)
 *   - Not-found returns 404
 *   - Inactive workflow → 400 ValidationError
 *   - DAG-invalid workflow → 400 with structured errors
 *   - Happy path returns HTTP 501 with code: 'NOT_IMPLEMENTED'
 *   - Rate-limit wiring via adminLimiter
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/execute/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/workflows/[id]/execute/route';
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
    aiWorkflow: {
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

// NOTE: validateWorkflow is NOT mocked — route uses the real implementation
// so we can verify the DAG validation path end-to-end.

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

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

const INVALID_DAG_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'First Step',
      type: 'llm_call',
      config: {},
      nextSteps: [{ targetStepId: 'does-not-exist' }],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

const VALID_BODY = {
  inputData: { key: 'value' },
  budgetLimitUsd: 10,
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    workflowDefinition: VALID_DEFINITION,
    patternsUsed: [],
    isActive: true,
    isTemplate: false,
    metadata: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown> = VALID_BODY): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/execute`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/workflows/:id/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when adminLimiter blocks the request', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(429);
    });
  });

  describe('CUID validation', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: false; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Body validation', () => {
    it('returns 400 when inputData is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({}), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when budgetLimitUsd is negative', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makePostRequest({ inputData: {}, budgetLimitUsd: -5 }),
        makeParams(WORKFLOW_ID)
      );

      expect(response.status).toBe(400);
    });
  });

  describe('Workflow lookup', () => {
    it('returns 404 when workflow not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(404);
    });
  });

  describe('Workflow isActive check', () => {
    it('returns 400 ValidationError when workflow is inactive', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ isActive: false }) as never
      );

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Pre-flight DAG validation', () => {
    it('returns 400 when workflow definition has an unknown nextStep target', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinition: INVALID_DAG_DEFINITION, isActive: true }) as never
      );

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string; details?: unknown } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      // details should carry the structured DAG errors
      expect(data.error.details).toBeDefined();
    });

    it('returns 400 when workflow definition has a cycle', async () => {
      const cycleDef = {
        steps: [
          {
            id: 'step-a',
            name: 'Step A',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'step-b' }],
          },
          {
            id: 'step-b',
            name: 'Step B',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'step-a' }],
          },
        ],
        entryStepId: 'step-a',
        errorStrategy: 'fail',
      };

      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinition: cycleDef, isActive: true }) as never
      );

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Happy path → 501 NOT_IMPLEMENTED', () => {
    it('returns HTTP 501 with NOT_IMPLEMENTED code when all validation passes', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(501);
      const data = await parseJson<{ success: boolean; error: { code: string; message: string } }>(
        response
      );
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_IMPLEMENTED');
      expect(data.error.message).toContain('Session 5.2');
    });
  });
});
