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
 *          tx.contactSubmission.deleteMany,
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
    // The delivery-payload redaction (t-783) goes through raw SQL on the tx client.
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    user: {
      count: vi.fn(),
      delete: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      // requestUserErasure's claim transaction.
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    session: { deleteMany: vi.fn() },
    aiApiKey: { updateMany: vi.fn() },
    aiAdminAuditLog: {
      updateMany: vi.fn(),
      createMany: vi.fn(),
    },
    contactSubmission: {
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    // eraseUser's colleague-subscription clear (t-786).
    aiWebhookSubscription: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    // eraseUser's config-recipient clear (t-791).
    aiOrchestrationSettings: {
      update: vi.fn(),
    },
    aiWorkflow: {
      update: vi.fn(),
    },
    aiWorkflowVersion: {
      update: vi.fn(),
    },
    aiWebhookDelivery: {
      updateMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
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
 * `user.findUniqueOrThrow` is read twice on the real chain: the claim reads the
 * intent columns it just wrote, and eraseUser reads the stored address. Answer
 * each with its own shape, keyed on what the caller selects.
 */
function mockStoredUser(stored: { email: string; emailVerified: boolean }) {
  vi.mocked(prisma.user.findUniqueOrThrow).mockImplementation((async (args: {
    select?: Record<string, boolean>;
  }) =>
    args.select?.erasureAttempts
      ? { erasureRequestedBy: SESSION_USER_ID, erasureReason: 'self_service', erasureAttempts: 1 }
      : stored) as never);
}

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
    vi.mocked(prisma.contactSubmission.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([]);
    // No colleague subscription matches and no delivery payload names the user.
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWebhookSubscription.updateMany).mockResolvedValue({ count: 0 });
    // Every lock erasure tries is free (t-840); every other raw read finds nothing.
    vi.mocked(prisma.$queryRaw).mockImplementation(((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('').includes('pg_try_advisory_xact_lock') ? [{ locked: true }] : []
      )) as never);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(0);
    vi.mocked(prisma.aiAdminAuditLog.createMany).mockResolvedValue({ count: 0 });
    // eraseUser reads the stored address for the contact delete. Deliberately
    // NOT the address the route passes in, so the assertion below can tell the
    // two apart: a stale session address must never be the one matched.
    mockStoredUser({ email: 'stored-self@example.com', emailVerified: true });

    // requestUserErasure's claim: a live account with no erasure pending yet,
    // which the conditional update claims (count 1).
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      erasureRequestedAt: null,
      erasureRequestedBy: null,
      erasureReason: null,
      erasureNextAttemptAt: null,
    } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.aiApiKey.updateMany).mockResolvedValue({ count: 0 });

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
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: {
          ...humanAdminWhere,
          OR: [{ erasureRequestedAt: null }, { id: SESSION_USER_ID }],
        },
      });

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

      // Four transactions: requestUserErasure's claim, the two delivery
      // pre-pass matches (each statement runs in a transaction of its own
      // under the request's deadline, t-845), then the real eraseUser's erase
      // chain. Its run pass after the commit (t-843) lists no run here, so
      // opens none.
      expect(prisma.$transaction).toHaveBeenCalledTimes(4);

      // The claim recorded the intent (conditional on the values it read) and
      // disabled the account BEFORE the erasure deleted the user row.
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: SESSION_USER_ID, erasureRequestedAt: null, erasureNextAttemptAt: null },
        data: expect.objectContaining({
          erasureRequestedBy: SESSION_USER_ID,
          erasureReason: 'self_service',
          erasureAttempts: { increment: 1 },
        }),
      });
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: SESSION_USER_ID },
      });
      expect(prisma.aiApiKey.updateMany).toHaveBeenCalledWith({
        where: { userId: SESSION_USER_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      const deleteCallOrder = vi.mocked(prisma.user.delete).mock.invocationCallOrder[0];
      expect(vi.mocked(prisma.session.deleteMany).mock.invocationCallOrder[0]).toBeLessThan(
        deleteCallOrder
      );

      // Inside $transaction: eraseUser scrubs residual PII on retained audit rows
      // before the userId FK is nulled by the cascade. Asserting the exact where/data
      // proves the route computed the correct userId from session.user.id.
      expect(prisma.aiAdminAuditLog.updateMany).toHaveBeenCalledWith({
        where: { userId: SESSION_USER_ID },
        data: { clientIp: null },
      });

      // Inside $transaction: contact-form messages (no FK to User, so no
      // cascade) are deleted by the erased user's stored address, matched exactly.
      expect(prisma.contactSubmission.deleteMany).toHaveBeenCalledWith({
        where: { email: 'stored-self@example.com' },
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
      // The config-recipient clear (t-791) ran on the real chain: the escalation
      // list (verified address), the drafts and the versions were all asked.
      const rawSql = vi
        .mocked(prisma.$queryRaw)
        .mock.calls.map((call) => (call[0] as unknown as TemplateStringsArray).join('?'));
      for (const table of [
        /FROM ai_orchestration_settings\s/,
        /FROM ai_workflow\s/,
        /FROM ai_workflow_version\s/,
      ]) {
        expect(rawSql.some((sql) => table.test(sql))).toBe(true);
      }

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

    it('redacts the stored address on deliveries sent to it, from the user row rather than the session, before deleting the user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count).mockResolvedValue(2);
      // Pass (a) reads retrying rows; pass (c) reads history-only rows.
      vi.mocked(prisma.aiWebhookDelivery.findMany).mockImplementation((async (args: {
        where: Record<string, unknown>;
      }) =>
        'AND' in args.where
          ? [
              {
                id: 'del-1',
                destination: 'stored-self@example.com',
                previousDestinations: null,
                lastError: 'SMTP 550',
              },
            ]
          : []) as never);
      vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 4 });

      const response = await DELETE(makeDeleteRequest({ confirmation: 'DELETE' }));

      expect(response.status).toBe(200);
      expect(prisma.aiWebhookDelivery.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.aiWebhookDelivery.findMany).toHaveBeenNthCalledWith(1, {
        where: {
          AND: [
            {
              OR: [
                { destination: 'stored-self@example.com' },
                {
                  previousDestinations: {
                    array_contains: [{ destination: 'stored-self@example.com' }],
                  },
                },
              ],
            },
            { status: { in: ['pending', 'failed'] } },
          ],
        },
        select: { id: true, destination: true, previousDestinations: true, lastError: true },
      });
      // The retrying row is stopped, keeping its real error, and its address
      // erased, only if it is still retrying when written (t-793).
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'del-1', status: { in: ['pending', 'failed'] } },
        data: {
          status: 'exhausted',
          nextRetryAt: null,
          lastError: 'SMTP 550 (not retried: recipient erased)',
          stoppedByErasure: true,
          destination: '[erased]',
          destinationFingerprint: null,
        },
      });
      // Every other row sent to the address is redacted in one statement.
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith({
        where: { destination: 'stored-self@example.com' },
        data: { destination: '[erased]', destinationFingerprint: null },
      });
      const deleteOrder = vi.mocked(prisma.user.delete).mock.invocationCallOrder[0];
      for (const fn of [
        prisma.aiWebhookDelivery.findMany,
        prisma.aiWebhookDelivery.update,
        prisma.aiWebhookDelivery.updateMany,
      ]) {
        for (const order of vi.mocked(fn).mock.invocationCallOrder) {
          expect(order).toBeLessThan(deleteOrder);
        }
      }
    });

    it('returns 409 CONFLICT and disables nothing when the real claim finds another attempt holding the lease', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      // A deletion already requested; its lease runs for another ten minutes.
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        erasureRequestedAt: new Date(Date.now() - 60_000),
        erasureRequestedBy: SESSION_USER_ID,
        erasureReason: 'self_service',
        erasureNextAttemptAt: new Date(Date.now() + 10 * 60_000),
      } as never);

      const response = await DELETE(makeDeleteRequest({ confirmation: 'DELETE' }));

      expect(response.status).toBe(409);
      const body = await parseJSON<ApiBody>(response);
      expect(body.success).toBe(false);
      expect((body as ErrorBody).error.code).toBe('CONFLICT');
      // Population: the claim transaction did open, and then declined.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
      // Its sessions are gone either way, so the cookies are torn down.
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_token');
    });

    it('touches no deliveries when the stored address is unverified', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count).mockResolvedValue(2);
      mockStoredUser({ email: 'stored-self@example.com', emailVerified: false });
      // An unverified address skips the delete and only counts what it left behind.
      vi.mocked(prisma.contactSubmission.count).mockResolvedValue(0);

      const response = await DELETE(makeDeleteRequest({ confirmation: 'DELETE' }));

      // Population: the erasure ran.
      expect(response.status).toBe(200);
      expect(prisma.user.delete).toHaveBeenCalledTimes(1);
      expect(prisma.aiWebhookDelivery.findMany).not.toHaveBeenCalled();
      expect(prisma.aiWebhookDelivery.update).not.toHaveBeenCalled();
      expect(prisma.aiWebhookDelivery.updateMany).not.toHaveBeenCalled();
      // ...nor any colleague's subscription: an unproven address may be a stranger's.
      // Only their own are read, to stop one that emails themselves (t-782).
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdBy: expect.any(String) }),
        })
      );
      expect(prisma.aiWebhookSubscription.updateMany).not.toHaveBeenCalled();
      expect(prisma.aiAdminAuditLog.createMany).not.toHaveBeenCalled();
    });

    it('clears every email subscription to the STORED address, the erased user’s own included (t-782), before the delivery passes and the user delete', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count).mockResolvedValue(2);
      const mk = (id: string, emailAddress: string | null) => ({
        id,
        emailAddress,
        isActive: true,
        orgId: 'org-a',
        createdBy: 'cmcolleague000000000000001',
      });
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
        mk('sub-exact', 'stored-self@example.com'),
        mk('sub-typed', '\tSTORED-SELF@EXAMPLE.COM '),
        mk('sub-other', 'someone-else@example.com'),
        mk('sub-session', 'session-copy@example.com'),
      ] as never);
      vi.mocked(prisma.aiWebhookSubscription.updateMany).mockResolvedValue({ count: 2 });
      vi.mocked(prisma.aiAdminAuditLog.createMany).mockResolvedValue({ count: 2 });

      const response = await DELETE(makeDeleteRequest({ confirmation: 'DELETE' }));

      expect(response.status).toBe(200);
      // The owner is excluded by the where; the address is never in the query.
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith({
        where: {
          channel: 'email',
          emailAddress: { not: null },
        },
        select: { id: true, emailAddress: true, isActive: true, orgId: true, createdBy: true },
      });
      // Matched in code on the user row's address (any case or whitespace),
      // not the session's copy, and not an unrelated address.
      expect(prisma.aiWebhookSubscription.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['sub-exact', 'sub-typed'] } },
        data: { emailAddress: null, isActive: false },
      });
      const audit = vi.mocked(prisma.aiAdminAuditLog.createMany).mock.calls[0]?.[0];
      expect(audit?.data).toEqual([
        expect.objectContaining({ entityId: 'sub-exact' }),
        expect.objectContaining({ entityId: 'sub-typed' }),
      ]);
      expect(JSON.stringify(audit).toLowerCase()).not.toContain('stored-self@example.com');
      // Cleared first: before the delivery-address passes, and before the user goes.
      const cleared = vi.mocked(prisma.aiWebhookSubscription.updateMany).mock
        .invocationCallOrder[0];
      const deliveryReads = vi.mocked(prisma.aiWebhookDelivery.findMany).mock.invocationCallOrder;
      const deliveryWrites = vi.mocked(prisma.aiWebhookDelivery.updateMany).mock
        .invocationCallOrder;
      expect(cleared).toBeLessThan(deliveryReads[0]);
      expect(cleared).toBeLessThan(deliveryWrites[0]);
      expect(cleared).toBeLessThan(vi.mocked(prisma.user.delete).mock.invocationCallOrder[0]);
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

      // The claim, the two delivery pre-pass matches (each in a transaction of
      // its own under the request's deadline, t-845) and the real eraseUser's
      // erase chain (its run pass after the commit, t-843, lists no run here,
      // so opens none)
      expect(prisma.$transaction).toHaveBeenCalledTimes(4);

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
