/**
 * Unit test for GET /api/v1/admin/orchestration/executions/:id/lease
 *
 * Tests the lease inspector endpoint: auth guards, CUID validation,
 * ownership scoping, token redaction, history query parameters, and the
 * regression guard that ensures the full token is never serialised in the
 * response body.
 *
 * `redactLeaseToken` is NOT mocked — the real helper runs so assertions
 * check the actual tail format (`…<last5>`), not a mock return value.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { parseJSON } from '@/tests/helpers/assertions';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: { findUnique: vi.fn() },
    aiWorkflowExecutionLeaseEvent: { findMany: vi.fn() },
  },
}));
vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { GET } from '@/app/api/v1/admin/orchestration/executions/[id]/lease/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Constants ───────────────────────────────────────────────────────────────

// A valid CUID2 (matches cuidSchema)
const EXEC_ID = 'cmjbv4i3x00003wsloputgwu9';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';

// The full token used in "active lease" tests.
// Must be > 5 chars so redaction produces `…lmnop`.
const FULL_TOKEN = 'abcdefghijklmnop';
const REDACTED_TOKEN = '…lmnop';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXEC_ID}/lease`,
    { method: 'GET' }
  );
}

function makeContext(id: string = EXEC_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeExecution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EXEC_ID,
    userId: USER_ID,
    leaseToken: FULL_TOKEN,
    leaseExpiresAt: new Date('2026-05-20T12:05:00.000Z'),
    lastHeartbeatAt: new Date('2026-05-20T12:04:00.000Z'),
    recoveryAttempts: 1,
    ...overrides,
  };
}

function makeLeaseEvents(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `event-${i}`,
    event: 'claimed',
    leaseToken: REDACTED_TOKEN,
    reason: 'fresh-resume',
    metadata: null,
    createdAt: new Date(`2026-05-20T12:0${i}:00.000Z`),
  }));
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
  vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
  vi.mocked(prisma.aiWorkflowExecutionLeaseEvent.findMany).mockResolvedValue(
    makeLeaseEvents(3) as never
  );
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/executions/:id/lease', () => {
  // ── 1. Auth: 401 unauthenticated ──────────────────────────────────────────

  it('returns 401 when the request has no session', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(401);
    const body = await parseJSON<{ success: boolean; error: { code: string } }>(res);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  // ── 2. Auth: 403 non-admin ────────────────────────────────────────────────

  it('returns 403 when the session belongs to a non-admin user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER') as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(403);
    const body = await parseJSON<{ success: boolean; error: { code: string } }>(res);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  // ── 3. Rate limiting: 429 ────────────────────────────────────────────────

  it('returns 429 when the admin rate limiter denies the request', async () => {
    vi.mocked(adminLimiter.check).mockReturnValueOnce({ success: false } as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(429);
  });

  // ── 4. Validation: 400 invalid CUID ──────────────────────────────────────

  it('returns 400 when the id path parameter is not a valid CUID', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/v1/admin/orchestration/executions/not-a-cuid/lease',
      { method: 'GET' }
    );
    const res = await GET(req, makeContext('not-a-cuid'));
    expect(res.status).toBe(400);
    const body = await parseJSON<{ success: boolean; error: { code: string } }>(res);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── 5. 404 execution not found ────────────────────────────────────────────

  it('returns 404 when the execution does not exist', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(404);
    const body = await parseJSON<{ success: boolean; error: { code: string } }>(res);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // ── 6. 404 cross-user access ──────────────────────────────────────────────

  it('returns 404 when the execution belongs to a different user', async () => {
    // Execution exists but userId does not match the session's user.id
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ userId: 'some-other-user-id' }) as never
    );
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(404);
    const body = await parseJSON<{ success: boolean; error: { code: string } }>(res);
    expect(body.success).toBe(false);
    // Route intentionally returns NOT_FOUND (not FORBIDDEN) to avoid disclosing
    // that the execution exists for another user.
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // ── 7. 200 with active lease ──────────────────────────────────────────────

  it('returns 200 with the redacted token tail and full lease metadata on an active lease', async () => {
    const expiresAt = new Date('2026-05-20T12:05:00.000Z');
    const lastHeartbeatAt = new Date('2026-05-20T12:04:00.000Z');
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({
        leaseToken: FULL_TOKEN,
        leaseExpiresAt: expiresAt,
        lastHeartbeatAt,
        recoveryAttempts: 1,
      }) as never
    );
    vi.mocked(prisma.aiWorkflowExecutionLeaseEvent.findMany).mockResolvedValue(
      makeLeaseEvents(3) as never
    );

    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(200);

    const body = await parseJSON<{
      success: boolean;
      data: {
        current: {
          token: string;
          expiresAt: string;
          lastHeartbeatAt: string;
          recoveryAttempts: number;
        };
        history: unknown[];
      };
    }>(res);

    expect(body.success).toBe(true);

    // Anti-green-bar: the route ran `redactLeaseToken(leaseToken)` — we verify
    // the transformation produced the `…<last5>` tail, not the raw token.
    expect(body.data.current.token).toBe(REDACTED_TOKEN);

    // Verify the route round-trips the other lease fields.
    expect(new Date(body.data.current.expiresAt).toISOString()).toBe(expiresAt.toISOString());
    expect(new Date(body.data.current.lastHeartbeatAt).toISOString()).toBe(
      lastHeartbeatAt.toISOString()
    );
    expect(body.data.current.recoveryAttempts).toBe(1);

    // History array matches what the mock returned.
    expect(body.data.history).toHaveLength(3);
  });

  // ── 8. 200 with no active lease (null token) ──────────────────────────────

  it('returns 200 with token null when leaseToken is null (execution has no active lease)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({
        leaseToken: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        recoveryAttempts: 2,
      }) as never
    );

    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(200);

    const body = await parseJSON<{
      success: boolean;
      data: { current: { token: string | null } };
    }>(res);

    // The real `redactLeaseToken(null)` returns null.
    // Assert the route returns null — not the string "null" or any other value.
    expect(body.data.current.token).toBeNull();
  });

  // ── 9. History limit honoured ─────────────────────────────────────────────

  it('queries the lease event history with take:50 and desc createdAt order', async () => {
    await GET(makeRequest(), makeContext());

    expect(prisma.aiWorkflowExecutionLeaseEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { executionId: EXEC_ID },
        take: 50,
        orderBy: { createdAt: 'desc' },
      })
    );
  });

  // ── 10. Regression: full token never appears in serialised response body ──

  it('never includes the full lease token in the serialised response body', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ leaseToken: FULL_TOKEN }) as never
    );

    const res = await GET(makeRequest(), makeContext());
    const raw = await res.text();

    // The full token must not appear anywhere in the JSON body.
    // This is the regression guard against a future change that accidentally
    // removes `redactLeaseToken` from the route and leaks the write-capability
    // secret to the browser.
    expect(raw).not.toContain(FULL_TOKEN);

    // Sanity check: the redacted tail IS present (proves the test is sensitive).
    expect(raw).toContain(REDACTED_TOKEN);
  });
});
