/**
 * Integration Test: Workflow DAG validation
 *
 * POST /api/v1/admin/orchestration/workflows/:id/validate
 *
 * Key behaviours:
 *   - Returns { ok: true, errors: [] } for a valid workflow definition
 *   - Returns { ok: false, errors: [...] } for a structurally invalid definition
 *   - The structural checks are distinct from Zod schema validation (DAG, cycles, etc.)
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/validate/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/workflows/[id]/validate/route';
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

// NOTE: validateWorkflow is NOT mocked — we test against the real implementation
// to verify the full integration between the route and the validator.

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

const UNKNOWN_TARGET_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'First Step',
      type: 'llm_call',
      config: {},
      nextSteps: [{ targetStepId: 'step-that-does-not-exist' }],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

const CYCLE_DEFINITION = {
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

function makeWorkflow(definition: unknown = VALID_DEFINITION) {
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    workflowDefinition: definition,
    patternsUsed: [],
    isActive: true,
    isTemplate: false,
    metadata: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve({}),
    url: `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/validate`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/workflows/:id/validate', () => {
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

  describe('CUID validation', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(), makeParams(INVALID_ID));

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

  describe('Valid workflow', () => {
    it('returns { ok: true, errors: [] } for a structurally valid definition', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow(VALID_DEFINITION) as never
      );

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { ok: boolean; errors: unknown[] } }>(
        response
      );
      expect(data.success).toBe(true);
      expect(data.data.ok).toBe(true);
      expect(data.data.errors).toHaveLength(0);
    });
  });

  describe('Invalid workflow definitions', () => {
    it('returns { ok: false, errors } with UNKNOWN_TARGET when nextStep refers to nonexistent step', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow(UNKNOWN_TARGET_DEFINITION) as never
      );

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { ok: boolean; errors: Array<{ code: string }> };
      }>(response);
      expect(data.data.ok).toBe(false);
      expect(data.data.errors.length).toBeGreaterThan(0);
      const codes = data.data.errors.map((e) => e.code);
      expect(codes).toContain('UNKNOWN_TARGET');
    });

    it('returns { ok: false, errors } with CYCLE_DETECTED for a cyclic definition', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow(CYCLE_DEFINITION) as never
      );

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { ok: boolean; errors: Array<{ code: string }> };
      }>(response);
      expect(data.data.ok).toBe(false);
      const codes = data.data.errors.map((e) => e.code);
      expect(codes).toContain('CYCLE_DETECTED');
    });

    it('returns { ok: false, errors } with MISSING_ENTRY when entry step id does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({
          steps: [{ id: 'step-1', name: 'Step', type: 'llm_call', config: {}, nextSteps: [] }],
          entryStepId: 'nonexistent-entry',
          errorStrategy: 'fail',
        }) as never
      );

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      const data = await parseJson<{
        data: { ok: boolean; errors: Array<{ code: string }> };
      }>(response);
      expect(data.data.ok).toBe(false);
      expect(data.data.errors.map((e) => e.code)).toContain('MISSING_ENTRY');
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(429);
    });
  });
});
