/**
 * Tests: Stream Workflow Execution (SSE)
 *
 * GET /api/v1/admin/orchestration/workflows/:id/execute-stream
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────

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

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { sseResponse } from '@/lib/api/sse';
import { validateWorkflow } from '@/lib/orchestration/workflows';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET as ExecuteStream } from '@/app/api/v1/admin/orchestration/workflows/[id]/execute-stream/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

// Valid CUID v2 format
const WORKFLOW_ID = 'clxxxxxxxxxxxxxxxxxxxxxxx';

/** A workflow definition that satisfies workflowDefinitionSchema */
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
  // Compatibility shim: tests still set `workflowDefinition` on overrides so
  // they can mutate the snapshot. We translate that to the published-version
  // relation that prepareWorkflowExecution reads.
  const { workflowDefinition: snapshotOverride, ...rest } = overrides;
  const snapshot = snapshotOverride ?? VALID_DEFINITION;
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    isActive: true,
    isTemplate: false,
    draftDefinition: null,
    publishedVersionId: 'wfv-1',
    publishedVersion: { id: 'wfv-1', version: 1, snapshot },
    patternsUsed: [],
    templateSource: null,
    metadata: {},
    createdBy: 'admin-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...rest,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(workflowId: string, params: Record<string, string> = {}): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/workflows/${workflowId}/execute-stream`
  );
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Restore defaults after clearAllMocks
  vi.mocked(validateWorkflow).mockReturnValue({ ok: true, errors: [] });
  vi.mocked(sseResponse).mockReturnValue(
    new Response('data: test\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  );
  mockExecute.mockReturnValue((async function* () {})());
});

describe('GET /workflows/:id/execute-stream', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await ExecuteStream(makeRequest(WORKFLOW_ID), makeParams(WORKFLOW_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: {
        id: 'session_1',
        userId: 'user_1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: 'user_1',
        name: 'Regular User',
        email: 'user@example.com',
        emailVerified: true,
        image: null,
        role: 'USER',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await ExecuteStream(makeRequest(WORKFLOW_ID), makeParams(WORKFLOW_ID));

    expect(response.status).toBe(403);
  });

  it('returns 400 for invalid workflow id format', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await ExecuteStream(
      makeRequest('not-a-valid-cuid'),
      makeParams('not-a-valid-cuid')
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when workflow does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

    const response = await ExecuteStream(makeRequest(WORKFLOW_ID), makeParams(WORKFLOW_ID));

    expect(response.status).toBe(404);
  });

  it('returns 400 when workflow is not active', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ isActive: false }) as never
    );

    const response = await ExecuteStream(makeRequest(WORKFLOW_ID), makeParams(WORKFLOW_ID));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when workflow definition is malformed', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ workflowDefinition: { invalid: true } }) as never
    );

    const response = await ExecuteStream(makeRequest(WORKFLOW_ID), makeParams(WORKFLOW_ID));

    expect(response.status).toBe(400);
  });

  it('returns 400 when workflow definition has structural errors', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(validateWorkflow).mockReturnValue({
      ok: false,
      errors: [{ code: 'CYCLE_DETECTED', message: 'Cycle detected in workflow graph' }],
    });

    const response = await ExecuteStream(makeRequest(WORKFLOW_ID), makeParams(WORKFLOW_ID));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when inputData is not valid JSON', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

    const response = await ExecuteStream(
      makeRequest(WORKFLOW_ID, { inputData: '{not-json' }),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when inputData is not a JSON object', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

    const response = await ExecuteStream(
      makeRequest(WORKFLOW_ID, { inputData: JSON.stringify([1, 2, 3]) }),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns SSE stream for a valid active workflow', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

    const response = await ExecuteStream(makeRequest(WORKFLOW_ID), makeParams(WORKFLOW_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    expect(sseResponse).toHaveBeenCalledOnce();
  });

  it('passes inputData to the engine when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

    await ExecuteStream(
      makeRequest(WORKFLOW_ID, { inputData: JSON.stringify({ key: 'value' }) }),
      makeParams(WORKFLOW_ID)
    );

    expect(mockExecute).toHaveBeenCalledWith(
      expect.anything(),
      { key: 'value' },
      expect.anything()
    );
  });

  it('passes budgetLimitUsd to the engine when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

    await ExecuteStream(
      makeRequest(WORKFLOW_ID, { budgetLimitUsd: '5.00' }),
      makeParams(WORKFLOW_ID)
    );

    expect(mockExecute).toHaveBeenCalledWith(
      expect.anything(),
      {},
      expect.objectContaining({ budgetLimitUsd: 5 })
    );
  });
});
