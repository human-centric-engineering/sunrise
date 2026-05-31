/**
 * Integration Test: DELETE /api/v1/users/me — eraseUser chain
 *
 * This file exercises the FULL route → guard → handler → real eraseUser →
 * mocked Prisma boundary chain.  It is intentionally narrower than
 * tests/integration/api/v1/users/me.test.ts, which covers all three handlers
 * but mocks eraseUser.  Here we let the real eraseUser run so we can assert on
 * the internal Prisma operations it performs inside $transaction.
 *
 * Test Coverage (DELETE /api/v1/users/me only):
 *   1. 401 — unauthenticated (withAuth guard fires before anything else)
 *   2. 400 LAST_ADMIN — admin session, adminCount === 1 → blocked before erase
 *   3. 200 happy path — non-last admin (count 2) self-delete:
 *        - real eraseUser ran: $transaction called, tx.aiAdminAuditLog.updateMany,
 *          tx.dataErasureReceipt.create, tx.user.delete all invoked with correct args
 *        - cookies cleared (4 deletes + 4 set-with-maxAge:0)
 *   4. 400 VALIDATION_ERROR — missing / invalid confirmation → no erase
 *
 * Mocking strategy:
 *   - @/lib/auth/config — controls the session returned by auth.api.getSession
 *     (mirrors the withAuth guard's actual call path; real guard runs)
 *   - @/lib/db/client prisma — $transaction invokes its callback with the SAME
 *     mocked prisma object so tx.x === prisma.x and assertions stay consistent
 *   - @/lib/storage/upload — isStorageEnabled → false (skip blob path)
 *   - next/headers cookies — captured mock store
 *   - @/lib/analytics/server serverTrack — no-op (not the focus here)
 *   - @/lib/privacy/erase-user is NOT mocked — the real module runs
 *
 * @see app/api/v1/users/me/route.ts
 * @see lib/privacy/erase-user.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE } from '@/app/api/v1/users/me/route';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
  createMockAuthSession,
} from '@/tests/helpers/auth';
import { parseJSON } from '@/tests/helpers/assertions';

// ---------------------------------------------------------------------------
// Mock declarations — hoisted before imports by Vitest
// ---------------------------------------------------------------------------

// Control session via auth.api.getSession (real withAuth guard runs)
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Prisma boundary — $transaction invokes its callback with the SAME mocked
// prisma so tx.aiAdminAuditLog === prisma.aiAdminAuditLog, etc. This is the
// critical design that makes the real eraseUser exercisable over a mock.
// $transaction is set to a plain vi.fn() and re-implemented in beforeEach so
// each test starts with a fresh, correctly-wired implementation.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    $transaction: vi.fn(),
    user: {
      count: vi.fn(),
      delete: vi.fn(),
    },
    aiAdminAuditLog: {
      updateMany: vi.fn(),
    },
    dataErasureReceipt: {
      create: vi.fn(),
    },
  },
}));

// Storage — skip avatar deletion (isStorageEnabled returns false)
vi.mock('@/lib/storage/upload', () => ({
  isStorageEnabled: vi.fn(() => false),
  deleteByPrefix: vi.fn(),
}));

// Cookie store — shared across the describe block; reset in beforeEach
const mockCookieStore = {
  delete: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
};

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => mockCookieStore),
}));

// Analytics — not the focus; suppress side effects
vi.mock('@/lib/analytics/server', () => ({
  serverTrack: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Module imports (after mock declarations)
// ---------------------------------------------------------------------------

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { humanAdminWhere } from '@/lib/auth/account';

// ---------------------------------------------------------------------------
// Constants & fixture helpers
// ---------------------------------------------------------------------------

/** Session user ID used by mockAdminUser() / mockAuthenticatedUser() */
const SESSION_USER_ID = 'cmjbv4i3x00003wsloputgwul';
const SESSION_USER_EMAIL = 'test@example.com';

/** Receipt fixture returned by prisma.dataErasureReceipt.create inside $transaction */
const RECEIPT_FIXTURE = {
  id: 'receipt-integration-1',
  subjectUserId: SESSION_USER_ID,
  subjectEmailHash: 'sha256hash',
  actorUserId: SESSION_USER_ID,
  reason: 'self_service',
  erasedAt: new Date('2026-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

/**
 * Build a DELETE NextRequest with the given JSON body.
 */
function makeDeleteRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/users/me', {
    method: 'DELETE',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Response type interfaces for type-safe assertions.
 */
interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

type ApiBody = SuccessBody | ErrorBody;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/users/me — eraseUser integration chain', () => {
  beforeEach(() => {
    // Clear call history; re-establish explicit return values so each test
    // starts from a known state. vi.clearAllMocks() resets call history only —
    // it does NOT reset mockResolvedValue implementations, so we re-apply them
    // explicitly (integration-pattern rule: module-level state reset in beforeEach).
    vi.clearAllMocks();

    // Default: unauthenticated (most tests override this)
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    // Default: admin count = 1 (last admin; most DELETE tests override this)
    vi.mocked(prisma.user.count).mockResolvedValue(1);

    // Default: dataErasureReceipt.create resolves with the fixture
    vi.mocked(prisma.dataErasureReceipt.create).mockResolvedValue(RECEIPT_FIXTURE as never);

    // Default: aiAdminAuditLog.updateMany resolves (returns void-like)
    vi.mocked(prisma.aiAdminAuditLog.updateMany).mockResolvedValue({ count: 0 });

    // Default: user.delete resolves
    vi.mocked(prisma.user.delete).mockResolvedValue({ id: SESSION_USER_ID } as never);

    // Wire $transaction to invoke its callback with the same mocked prisma object.
    // This is essential: the real eraseUser calls tx.aiAdminAuditLog.updateMany,
    // tx.dataErasureReceipt.create, and tx.user.delete inside the callback. By
    // passing `prisma` as `tx`, the same vi.fn() mocks are exercised and can be
    // asserted. A no-op $transaction would make case-3 assertions vacuous.
    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)
    );

    // Reset cookie store
    mockCookieStore.delete.mockReset();
    mockCookieStore.set.mockReset();
    mockCookieStore.get.mockReset();
  });

  // ── Case 1: 401 Unauthenticated ─────────────────────────────────────────────

  describe('Auth boundary (withAuth guard)', () => {
    it('returns 401 UNAUTHORIZED with full envelope when no session, and does not call DB', async () => {
      // Arrange — no session (withAuth throws UnauthorizedError)
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = makeDeleteRequest({ confirmation: 'DELETE' });

      // Act
      const response = await DELETE(request);

      // Assert — status first (integration quality requirement)
      expect(response.status).toBe(401);
      const body = await parseJSON<ApiBody>(response);
      expect(body.success).toBe(false);
      expect((body as ErrorBody).error.code).toBe('UNAUTHORIZED');

      // The guard must short-circuit before any Prisma work
      expect(prisma.user.count).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });
  });

  // ── Case 2: 400 LAST_ADMIN ───────────────────────────────────────────────────

  describe('Last-admin guard', () => {
    it('returns 400 LAST_ADMIN with full envelope when admin count is 1, and does not call $transaction', async () => {
      // Arrange — ADMIN session; count resolves 1 (last admin)
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count).mockResolvedValue(1);
      const request = makeDeleteRequest({ confirmation: 'DELETE' });

      // Act
      const response = await DELETE(request);

      // Assert — status first
      expect(response.status).toBe(400);
      const body = await parseJSON<ApiBody>(response);
      expect(body.success).toBe(false);
      expect((body as ErrorBody).error.code).toBe('LAST_ADMIN');
      // Message should reference transferring admin access
      expect((body as ErrorBody).error.message).toMatch(/admin/i);

      // Count gate was consulted (handler performed the DB check). Only real
      // human admins are counted (`humanAdminWhere`); the seeded non-login
      // SERVICE config-owner is excluded (issue #278 / security review).
      expect(prisma.user.count).toHaveBeenCalledWith({ where: humanAdminWhere });

      // erase must NOT have run — $transaction not called
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });
  });

  // ── Case 3: 200 happy path — real eraseUser chain ─────────────────────────

  describe('Happy path: non-last admin self-delete', () => {
    it('returns 200 { deleted:true } and the real eraseUser runs its full $transaction chain', async () => {
      // Arrange — ADMIN session with 2 admins (not the last)
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count).mockResolvedValue(2);

      const request = makeDeleteRequest({ confirmation: 'DELETE' });

      // Act
      const response = await DELETE(request);

      // Assert — status first (integration quality requirement)
      expect(response.status).toBe(200);
      const body = await parseJSON<SuccessBody>(response);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status 200
      expect(body.success).toBe(true);
      expect(body.data.deleted).toBe(true);

      // The real eraseUser opened a transaction — proves the erase chain ran
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // Inside $transaction: eraseUser scrubs residual PII on retained audit rows
      // before the userId FK is nulled by the cascade. Asserting the exact where/data
      // proves the route computed the correct userId from session.user.id.
      expect(prisma.aiAdminAuditLog.updateMany).toHaveBeenCalledWith({
        where: { userId: SESSION_USER_ID },
        data: { clientIp: null },
      });

      // Inside $transaction: eraseUser writes an erasure receipt (GDPR Art. 5(2)).
      // We assert the subjectUserId and reason — these are computed by the route
      // (reason='self_service', actorUserId===userId for self-service deletion),
      // not passed through from the mock.
      expect(prisma.dataErasureReceipt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subjectUserId: SESSION_USER_ID,
            actorUserId: SESSION_USER_ID,
            reason: 'self_service',
          }),
        })
      );

      // Inside $transaction: eraseUser deletes the user row last so cascades fire
      // after the PII scrub and receipt write.
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: SESSION_USER_ID },
      });

      // Cookies are cleared after a successful erase
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_token');
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_data');
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.csrf_token');
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.state');

      const secureCookieOptions = { path: '/', secure: true, maxAge: 0 };
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        '__Secure-better-auth.session_token',
        '',
        secureCookieOptions
      );
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        '__Secure-better-auth.session_data',
        '',
        secureCookieOptions
      );
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        '__Secure-better-auth.csrf_token',
        '',
        secureCookieOptions
      );
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        '__Secure-better-auth.state',
        '',
        secureCookieOptions
      );

      // Total cookie teardown: 4 deletes + 4 secure sets
      expect(mockCookieStore.delete).toHaveBeenCalledTimes(4);
      expect(mockCookieStore.set).toHaveBeenCalledTimes(4);
    });

    it('returns 200 { deleted:true } for a regular USER role (no admin count check)', async () => {
      // Arrange — USER role; the last-admin gate must be skipped entirely
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockAuthSession({
          user: {
            id: SESSION_USER_ID,
            email: SESSION_USER_EMAIL,
            name: 'Regular User',
            emailVerified: true,
            image: null,
            role: 'USER',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
      );

      const request = makeDeleteRequest({ confirmation: 'DELETE' });

      // Act
      const response = await DELETE(request);

      // Assert — status first
      expect(response.status).toBe(200);
      const body = await parseJSON<SuccessBody>(response);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status 200
      expect(body.success).toBe(true);
      expect(body.data.deleted).toBe(true);

      // Admin gate skipped — count not consulted for non-admins
      expect(prisma.user.count).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called

      // eraseUser still ran: $transaction was called
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // eraseUser called user.delete with the session's user ID
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: SESSION_USER_ID },
      });
    });
  });

  // ── Case 4: 400 VALIDATION_ERROR ────────────────────────────────────────────

  describe('Validation', () => {
    it('returns 400 VALIDATION_ERROR with full envelope when confirmation is absent, and no erase', async () => {
      // Arrange — authenticated USER; body missing `confirmation` key entirely
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const request = makeDeleteRequest({}); // no confirmation field

      // Act
      const response = await DELETE(request);

      // Assert — status first
      expect(response.status).toBe(400);
      const body = await parseJSON<ApiBody>(response);
      expect(body.success).toBe(false);
      expect((body as ErrorBody).error.code).toBe('VALIDATION_ERROR');

      // Validation short-circuits before any Prisma work
      expect(prisma.user.count).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });

    it('returns 400 VALIDATION_ERROR with full envelope when confirmation value is wrong, and no erase', async () => {
      // Arrange — authenticated USER; confirmation is lowercase (schema requires "DELETE")
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const request = makeDeleteRequest({ confirmation: 'delete' }); // lowercase — invalid

      // Act
      const response = await DELETE(request);

      // Assert — status first
      expect(response.status).toBe(400);
      const body = await parseJSON<ApiBody>(response);
      expect(body.success).toBe(false);
      expect((body as ErrorBody).error.code).toBe('VALIDATION_ERROR');

      // No erase attempted
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });
  });
});
