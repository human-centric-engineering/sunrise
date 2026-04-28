/**
 * Integration Test: Admin Orchestration — Revert Workflow Definition
 *
 * POST /api/v1/admin/orchestration/workflows/:id/definition-revert
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/definition-revert/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Bad CUID returns 400
 * - Missing workflow returns 404
 * - Malformed history returns 400 (ValidationError)
 * - versionIndex out of range returns 400
 * - 200 on success: current definition pushed onto history before revert
 * - CRITICAL: 500 responses do NOT leak raw error messages
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/workflows/[id]/definition-revert/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'http://localhost:3000',
  },
}));

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
      update: vi.fn(),
    },
    aiAdminAuditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';
const BASE_URL = `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/definition-revert`;

/** A valid workflow definition that passes workflowDefinitionSchema */
function makeValidDefinition(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

/** A well-formed history entry that passes workflowDefinitionHistorySchema */
function makeHistoryEntry(
  overrides: { definition?: Record<string, unknown>; changedAt?: string; changedBy?: string } = {}
) {
  return {
    definition: makeValidDefinition(),
    changedAt: '2024-01-01T00:00:00.000Z',
    changedBy: USER_ID,
    ...overrides,
  };
}

function makeWorkflowRow(
  overrides: {
    workflowDefinition?: Record<string, unknown>;
    workflowDefinitionHistory?: unknown;
  } = {}
) {
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    workflowDefinition: makeValidDefinition(),
    workflowDefinitionHistory: [makeHistoryEntry()],
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

function makeUpdatedWorkflow() {
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    workflowDefinition: makeValidDefinition(),
    workflowDefinitionHistory: [makeHistoryEntry(), makeHistoryEntry()],
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-06-01'),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown> = { versionIndex: 0 }): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
    url: BASE_URL,
  };
  return {
    ...base,
    clone: () => ({ ...base }),
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/workflows/:id/definition-revert', () => {
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
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(429);
    });
  });

  describe('Successful revert', () => {
    it('returns 200 with the updated workflow', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeUpdatedWorkflow() as never);

      const response = await POST(makePostRequest({ versionIndex: 0 }), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(WORKFLOW_ID);
    });

    it('pushes the current definition onto history before reverting', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const workflow = makeWorkflowRow({
        workflowDefinition: makeValidDefinition(),
        workflowDefinitionHistory: [makeHistoryEntry()],
      });
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(workflow as never);
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeUpdatedWorkflow() as never);

      await POST(makePostRequest({ versionIndex: 0 }), makeParams(WORKFLOW_ID));

      const updateCall = vi.mocked(prisma.aiWorkflow.update).mock.calls[0][0];
      // The new history should be longer than the original (current appended)
      const newHistory = updateCall.data.workflowDefinitionHistory as unknown[];
      expect(newHistory).toHaveLength(2); // 1 existing + 1 appended current
    });

    it('updates the workflowDefinition to the target history entry', async () => {
      const targetDef = makeValidDefinition({
        steps: [{ id: 'step-2', name: 'Target Step', type: 'chain', config: {}, nextSteps: [] }],
        entryStepId: 'step-2',
      });
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflowRow({
          workflowDefinitionHistory: [makeHistoryEntry({ definition: targetDef })],
        }) as never
      );
      vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeUpdatedWorkflow() as never);

      await POST(makePostRequest({ versionIndex: 0 }), makeParams(WORKFLOW_ID));

      const updateCall = vi.mocked(prisma.aiWorkflow.update).mock.calls[0][0];
      expect(updateCall.data.workflowDefinition).toEqual(targetDef);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when versionIndex is missing from body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);

      const response = await POST(makePostRequest({}), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when versionIndex is out of range', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // History has 1 entry (index 0 only); requesting index 5 is out of range
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);

      const response = await POST(makePostRequest({ versionIndex: 5 }), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when workflowDefinitionHistory is malformed', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflowRow({
          workflowDefinitionHistory: 'not-an-array',
        }) as never
      );

      const response = await POST(makePostRequest({ versionIndex: 0 }), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Not found', () => {
    it('returns 404 when workflow does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      const response = await POST(makePostRequest({ versionIndex: 0 }), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Error propagation', () => {
    it('CRITICAL: returns 500 on plain Error but does NOT leak raw error message', async () => {
      const INTERNAL_MSG = 'db-revert-exploded';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(prisma.aiWorkflow.update).mockRejectedValue(new Error(INTERNAL_MSG));

      const response = await POST(makePostRequest({ versionIndex: 0 }), makeParams(WORKFLOW_ID));

      expect(response.status).toBe(500);
      const raw = await response.text();
      expect(raw).not.toContain(INTERNAL_MSG);
    });
  });
});
