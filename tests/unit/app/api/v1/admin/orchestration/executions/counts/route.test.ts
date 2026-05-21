/**
 * Unit tests: Admin Orchestration — Execution status counts
 *
 * GET /api/v1/admin/orchestration/executions/counts?statuses=pending,running,...
 *
 * Covers:
 *   - Auth/rate-limit short-circuits (401 / 403 / 429)
 *   - Validation failures: missing statuses, invalid status value
 *   - Max-statuses cap (see case note below)
 *   - Happy path: zero-fill when groupBy returns []
 *   - Happy path: partial groupBy result overlaid on zero-fill
 *   - Security: groupBy scoped to session.user.id (critical assertion)
 *   - Dedup: duplicate statuses in CSV collapse before the DB call
 *   - Whitespace trim: URL-encoded spaces stripped from CSV tokens
 *
 * Note on case 6 (11-entry cap):
 *   `executionCountsQuerySchema` deduplicates via `new Set(...)` BEFORE the
 *   `.max(10)` check. Since only 6 valid WorkflowStatus values exist, a CSV
 *   of distinct valid statuses can never exceed 6 entries — the `.max(10)` cap
 *   cannot be triggered with valid-only input. Passing 11 distinct strings
 *   would fail the enum check first, not the max check. Testing "11 entries
 *   exceeds max" would be asserting Zod's built-in behaviour on an unreachable
 *   code path, not the route's logic. This case is intentionally omitted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mocks (must precede any import that loads the mocked modules) ────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: {
    check: vi.fn(() => ({ success: true, limit: 100, remaining: 99, reset: 0 })),
  },
  createRateLimitResponse: vi.fn(() => new Response(null, { status: 429 })),
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

// ─── Imports (after vi.mock calls) ───────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { GET } from '@/app/api/v1/admin/orchestration/executions/counts/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The id used in mockAdminUser() — must match so we can assert the where clause */
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(search = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/executions/counts${search}`,
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: admin session, rate-limit passes, groupBy returns empty
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  vi.mocked(adminLimiter.check).mockReturnValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: 0,
  });
  vi.mocked(prisma.aiWorkflowExecution.groupBy).mockResolvedValue([] as never);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/executions/counts', () => {
  // ── 1. Auth: unauthenticated ───────────────────────────────────────────────

  describe('Authentication and authorization', () => {
    it('returns 401 when no session exists and does not touch the database', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest('?statuses=pending'));

      expect(response.status).toBe(401);
      // Guard must short-circuit before the handler body reaches the DB
      expect(prisma.aiWorkflowExecution.groupBy).not.toHaveBeenCalled();
    });

    // ── 2. Auth: non-admin ─────────────────────────────────────────────────

    it('returns 403 when the session belongs to a non-admin user and does not touch the database', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest('?statuses=pending'));

      expect(response.status).toBe(403);
      // withAdminAuth must reject before the handler runs
      expect(prisma.aiWorkflowExecution.groupBy).not.toHaveBeenCalled();
    });
  });

  // ── 3. Rate-limiting ───────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    it('returns 429 when the rate limiter rejects the request and does not query the database', async () => {
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 100,
        remaining: 0,
        reset: Date.now() + 60_000,
      });

      const response = await GET(makeRequest('?statuses=pending'));

      expect(response.status).toBe(429);
      // The rate-limit branch must call the factory and NOT fall through to groupBy
      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(prisma.aiWorkflowExecution.groupBy).not.toHaveBeenCalled();
    });
  });

  // ── Validation failures ────────────────────────────────────────────────────

  describe('Query parameter validation', () => {
    it('returns 400 when the statuses param is missing and does not query the database', async () => {
      // Empty search string → no ?statuses key at all
      const response = await GET(makeRequest(''));

      expect(response.status).toBe(400);
      expect(prisma.aiWorkflowExecution.groupBy).not.toHaveBeenCalled();
    });

    it('returns 400 when statuses contains an invalid value and does not query the database', async () => {
      const response = await GET(makeRequest('?statuses=pending,not-a-real-status'));

      expect(response.status).toBe(400);
      expect(prisma.aiWorkflowExecution.groupBy).not.toHaveBeenCalled();
    });
  });

  // ── Happy path: zero-fill ──────────────────────────────────────────────────

  describe('Zero-fill when groupBy returns no rows', () => {
    it('returns 200 with every requested status initialised to 0 and no extra keys', async () => {
      vi.mocked(prisma.aiWorkflowExecution.groupBy).mockResolvedValue([] as never);

      const response = await GET(makeRequest('?statuses=pending,running,paused_for_approval'));
      const body = await parseJson<{
        success: boolean;
        data: { counts: Record<string, number> };
      }>(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Route must zero-fill every requested status — not return an empty object
      expect(body.data.counts).toEqual({
        pending: 0,
        running: 0,
        paused_for_approval: 0,
      });

      // Strict key check: no extra statuses sneaked in from the DB or route logic
      expect(Object.keys(body.data.counts)).toHaveLength(3);
    });
  });

  // ── Happy path: partial groupBy result ────────────────────────────────────

  describe('Partial groupBy result overlaid on zero-fill', () => {
    it('zero-fills statuses absent from groupBy and overlays counts for present statuses', async () => {
      vi.mocked(prisma.aiWorkflowExecution.groupBy).mockResolvedValue([
        { status: 'running', _count: { _all: 5 } },
        { status: 'paused_for_approval', _count: { _all: 2 } },
      ] as never);

      const response = await GET(makeRequest('?statuses=pending,running,paused_for_approval'));
      const body = await parseJson<{
        data: { counts: { pending: number; running: number; paused_for_approval: number } };
      }>(response);

      expect(response.status).toBe(200);
      // pending was absent from groupBy rows — route must default it to 0
      expect(body.data.counts.pending).toBe(0);
      // running and paused_for_approval are not just pass-throughs:
      // the route builds counts from groupBy._count._all, not the raw rows
      expect(body.data.counts.running).toBe(5);
      expect(body.data.counts.paused_for_approval).toBe(2);
    });
  });

  // ── Security: scoped to session.user.id ───────────────────────────────────

  describe('User-id scoping (security-critical)', () => {
    it('passes the authenticated admin id in the groupBy where clause', async () => {
      const response = await GET(makeRequest('?statuses=pending,running'));

      expect(response.status).toBe(200);

      // This is the key security assertion: if userId is missing or wrong,
      // executions from other users would be returned.
      const call = vi.mocked(prisma.aiWorkflowExecution.groupBy).mock.calls[0][0];
      expect(call.where).toEqual({
        userId: ADMIN_ID,
        status: { in: expect.arrayContaining(['pending', 'running']) },
      });
      // Confirm the where clause has exactly these two keys — no extra leakage
      expect(Object.keys(call.where as object)).toEqual(['userId', 'status']);
    });
  });

  // ── Dedup: duplicate CSV tokens collapse before the DB call ───────────────

  describe('Deduplication of repeated statuses', () => {
    it('passes a deduped array to groupBy when the CSV repeats a status', async () => {
      const response = await GET(makeRequest('?statuses=pending,pending,running'));

      expect(response.status).toBe(200);

      const call = vi.mocked(prisma.aiWorkflowExecution.groupBy).mock.calls[0][0];
      const inArg = (call.where as { status: { in: string[] } }).status.in;

      // Must be exactly 2 unique entries — pending not duplicated
      expect(inArg).toHaveLength(2);
      expect(inArg).toEqual(expect.arrayContaining(['pending', 'running']));
    });
  });

  // ── Whitespace trim: URL-encoded spaces stripped ───────────────────────────

  describe('CSV whitespace trimming', () => {
    it('strips leading/trailing whitespace from each CSV token before passing to groupBy', async () => {
      // %20 decodes to a space — "pending, running" after URL decode
      const response = await GET(makeRequest('?statuses=pending,%20running'));

      expect(response.status).toBe(200);

      const call = vi.mocked(prisma.aiWorkflowExecution.groupBy).mock.calls[0][0];
      const inArg = (call.where as { status: { in: string[] } }).status.in;

      // ' running' (with a leading space) must NOT appear — the schema trims tokens
      expect(inArg).not.toContain(' running');
      expect(inArg).toContain('running');
    });
  });
});
