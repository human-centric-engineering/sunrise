/**
 * Integration Test: Approve paused execution stub (501)
 *
 * POST /api/v1/admin/orchestration/executions/:id/approve
 *
 * This route is a full handler that validates auth, body, CUID, and execution
 * lookup — then returns 501 NOT_IMPLEMENTED. Deliberately does NOT check
 * execution.status — state-transition logic belongs with the real engine.
 *
 * Key assertions:
 *   - Auth guard blocks unauthenticated (401)
 *   - Body validation runs (bad body → 400)
 *   - CUID validation runs (bad id → 400)
 *   - Not-found returns 404
 *   - Rate-limit wiring via adminLimiter
 *   - Happy path returns HTTP 501 with code: 'NOT_IMPLEMENTED'
 *     and message containing "Session 5.2"
 *
 * @see app/api/v1/admin/orchestration/executions/[id]/approve/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/executions/[id]/approve/route';
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
    aiWorkflowExecution: {
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

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    status: 'paused_for_approval',
    inputData: {},
    executionTrace: [],
    currentStep: 'approval-step',
    errorMessage: null,
    totalCostUsd: null,
    budgetLimitUsd: null,
    startedAt: new Date('2025-01-01'),
    completedAt: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown> = {}): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}/approve`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/executions/:id/approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when adminLimiter blocks the request', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));

      expect(response.status).toBe(429);
    });
  });

  describe('CUID validation', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Body validation', () => {
    it('accepts empty body (all fields optional)', async () => {
      // approveExecutionBodySchema has all fields optional
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

      const response = await POST(makePostRequest({}), makeParams(EXECUTION_ID));

      // With a valid execution and valid (empty) body, we should reach the 501
      expect(response.status).toBe(501);
    });

    it('accepts body with approvalPayload and notes', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

      const response = await POST(
        makePostRequest({ approvalPayload: { decision: 'approved' }, notes: 'Looks good' }),
        makeParams(EXECUTION_ID)
      );

      expect(response.status).toBe(501);
    });

    it('returns 400 when notes exceeds 5000 characters', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makePostRequest({ notes: 'x'.repeat(5001) }),
        makeParams(EXECUTION_ID)
      );

      expect(response.status).toBe(400);
    });
  });

  describe('Execution lookup', () => {
    it('returns 404 when execution not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));

      expect(response.status).toBe(404);
    });
  });

  describe('No execution status check (by design)', () => {
    it('does NOT block approve for a non-paused execution (status checking deferred to engine)', async () => {
      // The route spec says: deliberately does NOT check execution.status
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({ status: 'running' }) as never
      );

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));

      // Still reaches 501 — status check is the engine's responsibility
      expect(response.status).toBe(501);
    });
  });

  describe('Happy path → 501 NOT_IMPLEMENTED', () => {
    it('returns HTTP 501 with NOT_IMPLEMENTED code when execution exists', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));

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
