/**
 * Integration Test: Get execution stub (501)
 *
 * GET /api/v1/admin/orchestration/executions/:id
 *
 * This route is a full handler that validates auth, CUID, and execution lookup
 * — then returns 501 NOT_IMPLEMENTED when the row is found.
 *
 * Key assertions:
 *   - Auth guard blocks unauthenticated (401)
 *   - CUID validation runs (bad id → 400)
 *   - Not-found returns 404
 *   - Happy path returns HTTP 501 with code: 'NOT_IMPLEMENTED'
 *     and message containing "Session 5.2"
 *
 * @see app/api/v1/admin/orchestration/executions/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/executions/[id]/route';
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

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    status: 'running',
    inputData: {},
    executionTrace: [],
    currentStep: null,
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

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/executions/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('CUID validation', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Execution lookup', () => {
    it('returns 404 when execution not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);

      const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));

      expect(response.status).toBe(404);
    });
  });

  describe('Happy path → 501 NOT_IMPLEMENTED', () => {
    it('returns HTTP 501 with NOT_IMPLEMENTED code when execution exists', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

      const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));

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
