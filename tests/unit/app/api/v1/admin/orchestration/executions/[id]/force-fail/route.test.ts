/**
 * Unit tests for POST /api/v1/admin/orchestration/executions/:id/force-fail.
 *
 * Mocks auth, rate-limiter, Prisma ($transaction callback variant),
 * recordForceFailEvent, logAdminAction, and emitHookEvent.
 *
 * Asserts:
 *   - 401 unauthenticated, 403 non-admin, 429 rate-limited
 *   - 400 on invalid CUID or reason that exceeds 500 chars
 *   - 404 when execution is missing or belongs to a different user
 *   - 409 when execution is already in a terminal state
 *   - 200 happy path from running / pending / paused_for_approval
 *   - errorMessage construction with and without reason
 *   - all side-effect calls (recordForceFailEvent, logAdminAction, emitHookEvent x2)
 *   - tx deletes running steps when updateMany count > 0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { parseJSON } from '@/tests/helpers/assertions';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));
vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/lease', () => ({
  recordForceFailEvent: vi.fn(),
}));
vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { POST } from '@/app/api/v1/admin/orchestration/executions/[id]/force-fail/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { recordForceFailEvent } from '@/lib/orchestration/engine/lease';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';

// ─── Constants ───────────────────────────────────────────────────────────────

const EXEC_ID = 'cmjbv4i3x00003wsloputgwu9';
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwf1';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const LEASE_TOKEN = 'lease-abc-123';
const OTHER_USER_ID = 'cmjbv4i3x00003wsloputgwox';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: unknown = {}): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXEC_ID}/force-fail`,
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

function makeExecution(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: EXEC_ID,
    userId: USER_ID,
    workflowId: WORKFLOW_ID,
    status: 'running',
    leaseToken: LEASE_TOKEN,
    ...overrides,
  };
}

// tx mock helpers — reset per-test in beforeEach
let txExecutionUpdateMany: ReturnType<typeof vi.fn>;
let txRunningStepDeleteMany: ReturnType<typeof vi.fn>;

function makeTxArg() {
  return {
    aiWorkflowExecution: { updateMany: txExecutionUpdateMany },
    aiWorkflowRunningStep: { deleteMany: txRunningStepDeleteMany },
  } as never;
}

function setupHappyTransaction(updateCount = 1): void {
  txExecutionUpdateMany = vi.fn().mockResolvedValue({ count: updateCount });
  txRunningStepDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
  vi.mocked(prisma.$transaction).mockImplementation(async (cb) => cb(makeTxArg()));
}

function setupTerminalTransaction(): void {
  txExecutionUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  txRunningStepDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  vi.mocked(prisma.$transaction).mockImplementation(async (cb) => cb(makeTxArg()));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /executions/:id/force-fail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── 1. Unauthenticated ────────────────────────────────────────────────────

  it('returns 401 when there is no session', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(401);
  });

  // ── 2. Non-admin role ─────────────────────────────────────────────────────

  it('returns 403 when the session user has the USER role', async () => {
    // mockAdminUser returns ADMIN; override to USER
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: {
        id: 's1',
        userId: USER_ID,
        expiresAt: new Date(),
        token: 't',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: USER_ID,
        email: 'user@example.com',
        name: 'User',
        emailVerified: true,
        image: null,
        role: 'USER',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(403);
  });

  // ── 3. Rate limited ───────────────────────────────────────────────────────

  it('returns 429 when the admin rate limiter rejects the request', async () => {
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 100,
      remaining: 0,
      reset: Date.now(),
    } as never);
    vi.mocked(createRateLimitResponse).mockReturnValue(
      Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
    );

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(429);
  });

  // ── 4. Invalid CUID ───────────────────────────────────────────────────────

  it('returns 400 when the id path segment is not a valid CUID', async () => {
    const res = await POST(
      new NextRequest(
        'http://localhost:3000/api/v1/admin/orchestration/executions/not-a-cuid/force-fail',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      ),
      makeContext('not-a-cuid')
    );

    expect(res.status).toBe(400);
    const body = await parseJSON<{ success: boolean; error: { code: string } }>(res);
    expect(body.success).toBe(false);
  });

  // ── 5. Reason too long ────────────────────────────────────────────────────

  it('returns 400 when reason exceeds 500 characters', async () => {
    const longReason = 'x'.repeat(501);

    const res = await POST(makeRequest({ reason: longReason }), makeContext());

    expect(res.status).toBe(400);
    const body = await parseJSON<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  // ── 6. Execution not found ────────────────────────────────────────────────

  it('returns 404 when the execution does not exist', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(404);
  });

  // ── 7. Cross-user scoping ─────────────────────────────────────────────────

  it('returns 404 (not 403) when the execution belongs to a different user', async () => {
    // The route scopes rows by userId and returns 404 on mismatch so that
    // admins cannot probe for other users' execution ids.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ userId: OTHER_USER_ID }) as never
    );

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(404);
  });

  // ── 8. Already terminal ───────────────────────────────────────────────────

  it('returns 409 when the execution is already in a terminal state', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique)
      // First findUnique: existence + ownership check
      .mockResolvedValueOnce(makeExecution({ status: 'completed' }) as never)
      // Second findUnique: re-read current status after count=0 from tx
      .mockResolvedValueOnce({ status: 'completed' } as never);

    setupTerminalTransaction();

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(409);
    const body = await parseJSON<{ success: boolean; error: { message: string } }>(res);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('completed');
  });

  // ── 9. Happy path — running ───────────────────────────────────────────────

  it('returns 200 and fires all side effects when force-failing a running execution', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'running' }) as never
    );
    setupHappyTransaction(1);

    const res = await POST(makeRequest(), makeContext());

    // Status code and envelope
    expect(res.status).toBe(200);
    const body = await parseJSON<{
      success: boolean;
      data: { executionId: string; previousStatus: string; status: string };
    }>(res);
    expect(body.success).toBe(true);
    expect(body.data.executionId).toBe(EXEC_ID);
    expect(body.data.previousStatus).toBe('running');
    expect(body.data.status).toBe('failed');

    // recordForceFailEvent receives the lease token and actor context
    expect(recordForceFailEvent).toHaveBeenCalledWith(
      EXEC_ID,
      LEASE_TOKEN,
      'admin-force-fail',
      expect.objectContaining({ actorUserId: USER_ID, previousStatus: 'running' })
    );

    // logAdminAction records the audit entry with the correct action
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'execution.force_failed',
        entityType: 'execution',
        entityId: EXEC_ID,
        metadata: expect.objectContaining({ previousStatus: 'running' }),
      })
    );

    // Two hook events — workflow.failed (existing integrations) and
    // execution.force_failed (admin-termination distinction)
    expect(emitHookEvent).toHaveBeenCalledWith(
      'workflow.failed',
      expect.objectContaining({ executionId: EXEC_ID, source: 'admin-force-fail' })
    );
    expect(emitHookEvent).toHaveBeenCalledWith(
      'execution.force_failed',
      expect.objectContaining({ executionId: EXEC_ID, actorUserId: USER_ID })
    );

    // The tx callback swept running steps
    expect(txRunningStepDeleteMany).toHaveBeenCalledWith({ where: { executionId: EXEC_ID } });
  });

  // ── 10. Happy path — pending ──────────────────────────────────────────────

  it('returns 200 when force-failing a pending execution', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'pending' }) as never
    );
    setupHappyTransaction(1);

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(200);
    const body = await parseJSON<{
      success: boolean;
      data: { previousStatus: string; status: string };
    }>(res);
    expect(body.data.previousStatus).toBe('pending');
    expect(body.data.status).toBe('failed');
  });

  // ── 11. Happy path — paused_for_approval ─────────────────────────────────

  it('returns 200 when force-failing a paused_for_approval execution', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'paused_for_approval' }) as never
    );
    setupHappyTransaction(1);

    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(200);
    const body = await parseJSON<{
      success: boolean;
      data: { previousStatus: string; status: string };
    }>(res);
    expect(body.data.previousStatus).toBe('paused_for_approval');
    expect(body.data.status).toBe('failed');
  });

  // ── 12. Reason is included in errorMessage and audit metadata ─────────────

  it('includes the reason in errorMessage and audit metadata when reason is supplied', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'running' }) as never
    );
    setupHappyTransaction(1);

    await POST(makeRequest({ reason: 'vendor down' }), makeContext());

    // The tx call must include the reason in the errorMessage data field
    const updateManyCall = txExecutionUpdateMany.mock.calls[0] as Array<{
      data: { errorMessage: string };
    }>;
    expect(updateManyCall[0].data.errorMessage).toBe('Force-failed by admin: vendor down');

    // The audit log must carry the reason in metadata
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'vendor down' }),
      })
    );
  });

  // ── 13. No reason → generic errorMessage and null audit reason ────────────

  it('uses the generic errorMessage and null reason in audit when no reason is provided', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'running' }) as never
    );
    setupHappyTransaction(1);

    await POST(makeRequest({}), makeContext());

    const updateManyCall = txExecutionUpdateMany.mock.calls[0] as Array<{
      data: { errorMessage: string };
    }>;
    expect(updateManyCall[0].data.errorMessage).toBe('Force-failed by admin');

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: null }),
      })
    );
  });
});
