/**
 * Unit Tests: Execute Workflow (POST SSE)
 *
 * POST /api/v1/admin/orchestration/workflows/:id/execute
 *
 * Test Coverage:
 * - Authentication: 401 unauthenticated, 403 non-admin
 * - Rate limiting: 429 when limiter rejects
 * - Workflow ID validation: 400 for non-CUID
 * - Workflow lookup: 404 when not found
 * - Workflow active check: 400 when isActive=false
 * - Workflow definition parse: 400 when definition fails Zod parse
 * - DAG validation: 400 when validateWorkflow returns errors
 * - Resume ownership guard: 404 when execution belongs to another user or workflow
 * - Happy path: SSE response returned for valid active workflow
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/execute/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (must appear before imports) ──────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: { findUnique: vi.fn() },
    aiWorkflowExecution: { findUnique: vi.fn() },
    aiWorkflowVersion: { findUnique: vi.fn() },
  },
}));

const RATE_LIMIT_ALLOW = { success: true, limit: 100, remaining: 99, reset: 9999999999 };
const RATE_LIMIT_DENY = { success: false, limit: 100, remaining: 0, reset: 9999999999 };

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: {
    check: vi.fn(() => ({ success: true, limit: 100, remaining: 99, reset: 9999999999 })),
  },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn().mockResolvedValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn(
    () =>
      new Response('data: test\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
  ),
}));

vi.mock('@/lib/orchestration/workflows', () => ({
  validateWorkflow: vi.fn(() => ({ ok: true, errors: [] })),
  semanticValidateWorkflow: vi.fn(() => Promise.resolve({ ok: true, errors: [] })),
}));

const mockExecute = vi.fn(() => (async function* () {})());

vi.mock('@/lib/orchestration/engine/orchestration-engine', () => {
  class MockOrchestrationEngine {
    execute = mockExecute;
  }
  return { OrchestrationEngine: MockOrchestrationEngine };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { sseResponse } from '@/lib/api/sse';
import { validateWorkflow } from '@/lib/orchestration/workflows';
import { adminLimiter } from '@/lib/security/rate-limit';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { POST } from '@/app/api/v1/admin/orchestration/workflows/[id]/execute/route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Valid CUID v2 (26 chars lowercase alphanumeric, starts with 'c')
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const EXECUTION_ID = 'cmjbv4i3x00004wsloputgwum';

/** A minimal workflow definition that satisfies workflowDefinitionSchema */
const VALID_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'LLM Step',
      type: 'llm_call',
      config: { model: 'gpt-4o-mini', prompt: 'Hello' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  // Compatibility shim — translates the legacy `workflowDefinition` override
  // to the published-version relation that the route now reads from.
  const { workflowDefinition: snapshotOverride, ...rest } = overrides;
  const snapshot = snapshotOverride === undefined ? VALID_DEFINITION : snapshotOverride;
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    isActive: true,
    isTemplate: false,
    draftDefinition: null,
    publishedVersionId: snapshot === null ? null : 'wfv-1',
    publishedVersion: snapshot === null ? null : { id: 'wfv-1', version: 1, snapshot },
    patternsUsed: [],
    templateSource: null,
    metadata: {},
    createdBy: 'admin-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...rest,
  };
}

// ─── Request / params helpers ─────────────────────────────────────────────────

function makeRequest(
  workflowId: string = WORKFLOW_ID,
  body: Record<string, unknown> = { inputData: {} },
  queryParams: Record<string, string> = {}
): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/workflows/${workflowId}/execute`
  );
  Object.entries(queryParams).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string = WORKFLOW_ID) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/workflows/:id/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore safe defaults after clearAllMocks
    vi.mocked(adminLimiter.check).mockReturnValue(RATE_LIMIT_ALLOW);
    vi.mocked(validateWorkflow).mockReturnValue({ ok: true, errors: [] });
    vi.mocked(sseResponse).mockReturnValue(
      new Response('data: test\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    mockExecute.mockReturnValue((async function* () {})());
  });

  describe('authentication', () => {
    it('should return 401 when unauthenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 403 when user is not admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert
      expect(response.status).toBe(403);
    });
  });

  describe('rate limiting', () => {
    it('should return rate-limit response when limiter check fails', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue(RATE_LIMIT_DENY);

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert
      expect(response.status).toBe(429);
      const body = await parseJson<{ error: { code: string } }>(response);
      expect(body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('workflow ID validation', () => {
    it('should return 400 with ValidationError for invalid (non-CUID) workflow ID', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const invalidId = 'not-a-valid-cuid';

      // Act
      const response = await POST(makeRequest(invalidId), makeParams(invalidId));

      // Assert
      expect(response.status).toBe(400);
      const body = await parseJson<{ error: { code: string } }>(response);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('workflow lookup', () => {
    it('should return 404 when workflow does not exist in the database', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert
      expect(response.status).toBe(404);
      const body = await parseJson<{ error: { code: string } }>(response);
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('workflow active check', () => {
    it('should return 400 when workflow is not active', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ isActive: false }) as never
      );

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert
      expect(response.status).toBe(400);
      const body = await parseJson<{ error: { code: string } }>(response);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('workflow definition validation', () => {
    it('should return 400 when workflow definition fails Zod parse (malformed definition)', async () => {
      // Arrange: definition does not satisfy workflowDefinitionSchema
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinition: { invalid: true, missing: 'required fields' } }) as never
      );

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert
      expect(response.status).toBe(400);
      const body = await parseJson<{ error: { code: string } }>(response);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when DAG validation fails (structural errors)', async () => {
      // Arrange: definition parses fine but has a cycle or unreachable step
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(validateWorkflow).mockReturnValue({
        ok: false,
        errors: [{ code: 'CYCLE_DETECTED', message: 'Cycle detected in workflow graph' }],
      });

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert
      expect(response.status).toBe(400);
      const body = await parseJson<{ error: { code: string } }>(response);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('resume execution ownership guard', () => {
    it('should return 404 when resume execution has wrong userId (cross-user resume)', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
        id: EXECUTION_ID,
        userId: 'different-user-id', // different user — ownership violation
        workflowId: WORKFLOW_ID,
      } as never);

      // Act
      const response = await POST(
        makeRequest(WORKFLOW_ID, { inputData: {} }, { resumeFromExecutionId: EXECUTION_ID }),
        makeParams()
      );

      // Assert — returns 404 (not 403) to avoid confirming existence of another user's execution
      expect(response.status).toBe(404);
      const body = await parseJson<{ error: { code: string } }>(response);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('should return 404 when resume execution has wrong workflowId', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
        id: EXECUTION_ID,
        userId: adminSession.user.id,
        workflowId: 'cmjbv4i3x00009wsloputgwuz', // different workflow
      } as never);

      // Act
      const response = await POST(
        makeRequest(WORKFLOW_ID, { inputData: {} }, { resumeFromExecutionId: EXECUTION_ID }),
        makeParams()
      );

      // Assert
      expect(response.status).toBe(404);
    });

    it('should return 404 when resume execution record does not exist', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);

      // Act
      const response = await POST(
        makeRequest(WORKFLOW_ID, { inputData: {} }, { resumeFromExecutionId: EXECUTION_ID }),
        makeParams()
      );

      // Assert
      expect(response.status).toBe(404);
    });
  });

  describe('happy path — valid workflow execution', () => {
    it('should return an SSE response for a valid active workflow', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/event-stream');
      expect(sseResponse).toHaveBeenCalledOnce();
    });

    it('should instantiate OrchestrationEngine and call execute with correct arguments', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      // Act
      await POST(
        makeRequest(WORKFLOW_ID, { inputData: { key: 'value' }, budgetLimitUsd: 5 }),
        makeParams()
      );

      // Assert — engine.execute called with workflow + inputData + options
      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({ id: WORKFLOW_ID }),
        { key: 'value' },
        expect.objectContaining({
          userId: adminSession.user.id,
          budgetLimitUsd: 5,
        })
      );
    });

    it('should pass resumeFromExecutionId to the engine when provided and ownership check passes', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
        id: EXECUTION_ID,
        userId: adminSession.user.id,
        workflowId: WORKFLOW_ID,
        versionId: 'wfv-1',
      } as never);
      // Resume now pins to the executions versionId — provide the version row.
      vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue({
        id: 'wfv-1',
        workflowId: WORKFLOW_ID,
        version: 1,
        snapshot: VALID_DEFINITION,
      } as never);

      // Act
      await POST(
        makeRequest(WORKFLOW_ID, { inputData: {} }, { resumeFromExecutionId: EXECUTION_ID }),
        makeParams()
      );

      // Assert
      expect(mockExecute).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ resumeFromExecutionId: EXECUTION_ID })
      );
    });
  });

  describe('resume version pinning', () => {
    it('passes the executions row versionId to the engine on resume (not the workflows current published version)', async () => {
      // Pin a paused execution to v1 of a workflow whose current published
      // version is v2. Resume must run against v1 — that's the whole point
      // of the publish/draft model. Currently the helper resolves to the
      // workflows publishedVersion, so we need to verify the resume path
      // overrides that with the executions stamped versionId.
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);

      // Workflow row: currently published is v2.
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({
          publishedVersionId: 'wfv-v2',
          publishedVersion: { id: 'wfv-v2', version: 2, snapshot: VALID_DEFINITION },
        }) as never
      );
      // The pinned v1 row that the execution row originally ran against.
      // Use a slightly different snapshot so we can prove the engine sees v1.
      const v1Snapshot = {
        ...VALID_DEFINITION,
        steps: VALID_DEFINITION.steps.map((s, i) =>
          i === 0 ? { ...s, name: 'Pinned-v1 step' } : s
        ),
      };
      vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue({
        id: 'wfv-v1',
        workflowId: WORKFLOW_ID,
        version: 1,
        snapshot: v1Snapshot,
      } as never);
      // Execution row: pinned to v1.
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
        id: EXECUTION_ID,
        userId: adminSession.user.id,
        workflowId: WORKFLOW_ID,
        versionId: 'wfv-v1',
      } as never);

      await POST(
        makeRequest(WORKFLOW_ID, { inputData: {} }, { resumeFromExecutionId: EXECUTION_ID }),
        makeParams()
      );

      // Engine should receive v1 as the pinned versionId AND v1's snapshot
      // as the definition — NOT v2.
      const allCalls = mockExecute.mock.calls as unknown as Array<
        [{ versionId?: string; definition?: { steps: Array<{ name: string }> } }, ...unknown[]]
      >;
      const callArgs = allCalls[0]?.[0];
      expect(callArgs?.versionId).toBe('wfv-v1');
      expect(callArgs?.definition?.steps[0]?.name).toBe('Pinned-v1 step');
    });

    it('404s when the executions originally-pinned version was deleted', async () => {
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
        id: EXECUTION_ID,
        userId: adminSession.user.id,
        workflowId: WORKFLOW_ID,
        versionId: 'wfv-deleted',
      } as never);
      // The pinned version row is gone.
      vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(null);

      const response = await POST(
        makeRequest(WORKFLOW_ID, { inputData: {} }, { resumeFromExecutionId: EXECUTION_ID }),
        makeParams()
      );
      expect(response.status).toBe(404);
    });
  });
});
