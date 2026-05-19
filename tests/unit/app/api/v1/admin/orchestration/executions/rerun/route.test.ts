/**
 * Unit tests for POST /api/v1/admin/orchestration/executions/:id/rerun.
 *
 * Mocks auth, Prisma, the rate-limiter, prepareWorkflowExecution, the
 * OrchestrationEngine, and the SSE helper. Asserts:
 *   - 404 on malformed / cross-user / missing execution ids
 *   - 400 on a versionId that belongs to a different workflow
 *   - happy path: defaults to workflow's published version, copies
 *     inputData + budgetLimitUsd, forwards parentExecutionId to engine
 *   - explicit versionId override is honoured
 *   - explicit budgetLimitUsd override wins over the original's
 *
 * Doesn't run the engine — `OrchestrationEngine.execute` is mocked
 * to a benign async-iterable stub. We assert on the call shape, not
 * on actual workflow execution.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: { findFirst: vi.fn() },
    aiWorkflowVersion: { findFirst: vi.fn() },
  },
}));
vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
// Stub prepareWorkflowExecution so we don't have to mount a workflow row +
// version row + run the structural validator. The route is the unit under
// test here; the helper has its own coverage.
vi.mock('@/app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers', () => ({
  prepareWorkflowExecution: vi.fn(),
}));
// `sseResponse` returns a Response; the route's return value is shoved
// straight through. A stub keeps the assertions in this file deterministic.
vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn(() => new Response('stub-sse-body', { status: 200 })),
}));
// Engine: only the constructor + execute method are touched. The real
// engine creates a DB row — we don't want that here. The mock uses a
// real `function` (not an arrow) because vitest's mock-as-class
// detection requires the constructor to be invocable via `new`.
// The explicit signature is necessary so `mock.calls[i][n]` is
// indexable as a tuple at the assertion site — without it vitest
// types `mock.calls` as `[][]` and TS rejects the destructuring.
const engineExecuteMock = vi.fn(
  (
    _workflow: { id: string; versionId: string },
    _inputData: Record<string, unknown>,
    _options: {
      userId: string;
      budgetLimitUsd?: number;
      parentExecutionId?: string;
    }
  ): AsyncIterable<unknown> => {
    // The route passes the AsyncIterable to sseResponse, which we have
    // mocked above — so the iterable is never actually consumed in the
    // test. Returning an empty async iterator keeps types happy.
    return (async function* () {})();
  }
);
vi.mock('@/lib/orchestration/engine/orchestration-engine', () => ({
  OrchestrationEngine: function OrchestrationEngineMock() {
    return { execute: engineExecuteMock };
  },
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { POST } from '@/app/api/v1/admin/orchestration/executions/[id]/rerun/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { prepareWorkflowExecution } from '@/app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers';

// ─── Helpers ────────────────────────────────────────────────────────────────

const EXEC_ID = 'cmjbv4i3x00003wsloputgwu9';
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwf1';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const ORIGINAL_VERSION_ID = 'cmjbv4i3x00003wsloputgwv1';
const NEW_VERSION_ID = 'cmjbv4i3x00003wsloputgwv2';
const CROSS_WF_VERSION_ID = 'cmjbv4i3x00003wsloputgwxv';

function makeRequest(body: unknown = {}): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXEC_ID}/rerun`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function makeContext(id: string = EXEC_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeOriginal(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: EXEC_ID,
    workflowId: WORKFLOW_ID,
    inputData: { hello: 'world' },
    budgetLimitUsd: 5,
    versionId: ORIGINAL_VERSION_ID,
    ...overrides,
  };
}

function happyPrepare(versionId: string = ORIGINAL_VERSION_ID): {
  workflow: { id: string };
  version: { id: string; version: number };
  definition: { steps: never[]; entryStepId: string; errorStrategy: 'fail' };
} {
  return {
    workflow: { id: WORKFLOW_ID },
    version: { id: versionId, version: 1 },
    definition: { steps: [], entryStepId: 'x', errorStrategy: 'fail' },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /executions/:id/rerun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mockAdminUser() returns a session object; we have to install it
    // on the auth.api.getSession mock ourselves — that's the project's
    // convention (see other admin-route tests).
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
  });

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(401);
  });

  it('returns 404 on a malformed execution id (does not leak existence)', async () => {
    const res = await POST(
      new NextRequest(
        'http://localhost:3000/api/v1/admin/orchestration/executions/not-a-cuid/rerun',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      ),
      makeContext('not-a-cuid')
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the execution does not exist or belongs to another user', async () => {
    // Ownership is scoped at the query — cross-user lookups return null,
    // which the route surfaces as 404 to match the existing privacy
    // contract on other execution routes (no 403 leak).
    vi.mocked(prisma.aiWorkflowExecution.findFirst).mockResolvedValue(null);

    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(404);
  });

  it('returns 400 when versionId belongs to a different workflow', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findFirst).mockResolvedValue(makeOriginal() as never);
    vi.mocked(prisma.aiWorkflowVersion.findFirst).mockResolvedValue(null);

    const res = await POST(makeRequest({ versionId: CROSS_WF_VERSION_ID }), makeContext());
    expect(res.status).toBe(400);
    expect(prepareWorkflowExecution).not.toHaveBeenCalled();
  });

  it('happy path: defaults to current published version when versionId is omitted', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findFirst).mockResolvedValue(makeOriginal() as never);
    vi.mocked(prepareWorkflowExecution).mockResolvedValue(happyPrepare(NEW_VERSION_ID) as never);

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(200);
    // prepareWorkflowExecution was called with `pinnedVersionId: null`
    // — that signals the helper to fall back to the workflow's
    // current publishedVersionId.
    expect(prepareWorkflowExecution).toHaveBeenCalledWith(WORKFLOW_ID, {
      pinnedVersionId: null,
    });
  });

  it('forwards parentExecutionId, copied inputData, and original budget to the engine', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findFirst).mockResolvedValue(makeOriginal() as never);
    vi.mocked(prepareWorkflowExecution).mockResolvedValue(happyPrepare(NEW_VERSION_ID) as never);

    await POST(makeRequest(), makeContext());

    // The engine.execute call shape is the contract — assert the three
    // fields that the rerun route is responsible for setting correctly.
    const [workflowArg, inputData, options] = engineExecuteMock.mock.calls[0];
    expect(workflowArg).toMatchObject({ id: WORKFLOW_ID, versionId: NEW_VERSION_ID });
    expect(inputData).toEqual({ hello: 'world' });
    expect(options).toMatchObject({
      userId: USER_ID,
      budgetLimitUsd: 5, // copied from the original
      parentExecutionId: EXEC_ID, // lineage link
    });
  });

  it('explicit versionId override pins the helper to that version', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findFirst).mockResolvedValue(makeOriginal() as never);
    vi.mocked(prisma.aiWorkflowVersion.findFirst).mockResolvedValue({
      id: NEW_VERSION_ID,
    } as never);
    vi.mocked(prepareWorkflowExecution).mockResolvedValue(happyPrepare(NEW_VERSION_ID) as never);

    await POST(makeRequest({ versionId: NEW_VERSION_ID }), makeContext());

    expect(prepareWorkflowExecution).toHaveBeenCalledWith(WORKFLOW_ID, {
      pinnedVersionId: NEW_VERSION_ID,
    });
  });

  it('explicit budgetLimitUsd in the body wins over the original execution', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findFirst).mockResolvedValue(makeOriginal() as never);
    vi.mocked(prepareWorkflowExecution).mockResolvedValue(happyPrepare() as never);

    await POST(makeRequest({ budgetLimitUsd: 12 }), makeContext());

    const [, , options] = engineExecuteMock.mock.calls[0];
    expect(options.budgetLimitUsd).toBe(12);
  });

  it('original null budget passes through as undefined (engine treats as no limit)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findFirst).mockResolvedValue(
      makeOriginal({ budgetLimitUsd: null }) as never
    );
    vi.mocked(prepareWorkflowExecution).mockResolvedValue(happyPrepare() as never);

    await POST(makeRequest(), makeContext());

    const [, , options] = engineExecuteMock.mock.calls[0];
    // Engine contract: undefined → skip the budget check. We do NOT
    // pass null because Prisma null was deliberate "no limit"; null
    // and undefined have to coalesce at the engine boundary.
    expect(options.budgetLimitUsd).toBeUndefined();
  });
});
