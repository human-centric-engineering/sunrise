/**
 * Integration Test: User by ID Endpoints
 *
 * Tests the GET/PATCH/DELETE /api/v1/users/:id endpoints for the full
 * request → auth → handler → DB → response contract.
 *
 * Test Coverage:
 * GET /api/v1/users/:id:
 * - 401 unauthenticated (withAuth guard)
 * - 403 non-admin fetching another user's profile
 * - 200 admin fetches any user (no password in body)
 * - 404 user not found
 *
 * PATCH /api/v1/users/:id:
 * - 401 unauthenticated (withAdminAuth guard)
 * - 403 non-admin
 * - 200 + DB readback via updatedAt drift
 * - 400 SELF_ROLE_CHANGE envelope
 * - 400 VALIDATION_ERROR on empty body
 *
 * DELETE /api/v1/users/:id (withAdminAuth — real eraseUser over mocked Prisma):
 * - 401 unauthenticated (withAdminAuth guard)
 * - 403 non-admin
 * - 200 happy — receipt create + audit scrub + user.delete via $transaction
 * - 400 CANNOT_DELETE_SELF (self-guard short-circuits before findUnique)
 * - 400 CANNOT_DELETE_ADMIN (target role === 'ADMIN')
 * - 404 user not found
 * - 400 VALIDATION_ERROR invalid ID format
 *
 * @see app/api/v1/users/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/v1/users/[id]/route';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  createMockAuthSession,
} from '@/tests/helpers/auth';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

// Mock better-auth config — integration tests exercise the REAL guard (withAuth / withAdminAuth)
// by controlling the session returned from auth.api.getSession.
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Mock Prisma — this IS the DB boundary for integration tests in this project.
// Do NOT instantiate real PrismaClient or read process.env.DATABASE_URL.
// $transaction is mocked to invoke its callback with the same prisma mock so
// tx.aiAdminAuditLog / tx.dataErasureReceipt / tx.user resolve through the
// same vi.fn() spies. A no-op $transaction mock would make all downstream
// assertions vacuous (green-bar risk — see test-plan.md brittle-patterns note).
vi.mock('@/lib/db/client', () => ({
  prisma: {
    $transaction: vi.fn(),
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
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

// Mock storage — default to disabled; override isStorageEnabled per test when needed.
vi.mock('@/lib/storage/upload', () => ({
  deleteByPrefix: vi.fn(),
  isStorageEnabled: vi.fn(() => false),
}));

// Import mocked modules for per-test configuration
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ---------------------------------------------------------------------------
// Constants & fixture helpers
// ---------------------------------------------------------------------------

/**
 * A valid CUID that passes the userIdSchema (z.cuid() / c[a-z0-9]{24}).
 * This represents the target user being fetched/updated/deleted.
 * Intentionally different from the admin's own ID (cmjbv4i3x00003wsloputgwul).
 */
const TARGET_USER_ID = 'clzx9k8p40000x8c2g3h5m7b1';

/** ID used by the default admin session from mockAdminUser() */
const ADMIN_USER_ID = 'cmjbv4i3x00003wsloputgwul';

/**
 * Build a context object for the route handler with async params (Next.js 16 requirement).
 */
function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Create a GET NextRequest for the [id] endpoint.
 */
function makeGetRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/users/${id}`);
}

/**
 * Create a PATCH NextRequest with a JSON body.
 */
function makePatchRequest(id: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Create a DELETE NextRequest.
 */
function makeDeleteRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/users/${id}`, {
    method: 'DELETE',
  });
}

/**
 * A representative non-admin user fixture returned by prisma.user.findUnique.
 * Includes the full Prisma User shape (not just the handler's select projection)
 * because `mockResolvedValue` is typed against the Prisma model.
 */
function makeUserFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_USER_ID,
    name: 'Target User',
    email: 'target@example.com',
    role: 'USER',
    accountType: 'HUMAN' as const,
    emailVerified: true,
    image: null,
    bio: null,
    phone: null,
    timezone: 'UTC',
    location: null,
    preferences: {},
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Parse JSON from a Response (mirrors the helper in the sibling integration tests).
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('GET /api/v1/users/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish defaults after clearAllMocks — clearAllMocks only resets
    // call history, not implementations. Explicit reset ensures test isolation.
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
  });

  describe('Auth boundary (withAuth)', () => {
    it('should return 401 with UNAUTHORIZED envelope when unauthenticated, and not call DB', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = makeGetRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await GET(request, context);

      // Assert — status first (brittle-patterns rule: status before body)
      expect(response.status).toBe(401);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      // Proves the guard short-circuited before reaching any DB call
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 403 with FORBIDDEN envelope when non-admin requests another user profile, and not call DB', async () => {
      // Arrange — authenticated as a regular USER whose ID differs from the target.
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockAuthSession({
          user: {
            id: ADMIN_USER_ID, // Different from TARGET_USER_ID — triggers 403
            email: 'user-a@example.com',
            name: 'User A',
            emailVerified: true,
            image: null,
            role: 'USER', // Non-admin — the only role field the guard checks
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
      );
      const request = makeGetRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await GET(request, context);

      // Assert — status first
      expect(response.status).toBe(403);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
      // Proves the ownership check short-circuited before reaching the DB
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  describe('Self-access (own profile)', () => {
    it('should return 200 with own profile when authenticated USER fetches their own ID', async () => {
      // Arrange — non-admin session where session.user.id === params.id (the self-access branch).
      // The GET guard at source L50 allows: session.user.id === id || role === 'ADMIN'.
      // This test exercises the first branch (self-access) with a USER role.
      const SELF_USER_ID = 'clzx9k8p40001x8c2g3h5m7b2'; // distinct from ADMIN_USER_ID and TARGET_USER_ID

      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockAuthSession({
          user: {
            id: SELF_USER_ID,
            email: 'self@example.com',
            name: 'Self User',
            emailVerified: true,
            image: null,
            role: 'USER',
            createdAt: new Date('2025-06-01T00:00:00.000Z'),
            updatedAt: new Date('2025-06-01T00:00:00.000Z'),
          },
        })
      );

      const selfFixture = makeUserFixture({
        id: SELF_USER_ID,
        email: 'self@example.com',
        name: 'Self User',
        role: 'USER',
        createdAt: new Date('2025-06-01T00:00:00.000Z'),
        updatedAt: new Date('2025-06-01T00:00:00.000Z'),
      });
      vi.mocked(prisma.user.findUnique).mockResolvedValue(selfFixture);

      const request = makeGetRequest(SELF_USER_ID);
      const context = makeContext(SELF_USER_ID);

      // Act
      const response = await GET(request, context);

      // Assert — status first (integration contract rule)
      expect(response.status).toBe(200);
      const body = await parseResponse<{
        success: boolean;
        data: {
          id: string;
          email: string;
          createdAt: string;
          updatedAt: string;
          role: string;
        };
      }>(response);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(body.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      // Handler-derived fields — these come from the DB fixture, not the request, proving
      // the handler fetched the row and wrapped it, rather than echoing session data.
      expect(body.data.id).toBe(SELF_USER_ID);
      expect(body.data.email).toBe('self@example.com');
      expect(new Date(body.data.createdAt).toISOString()).toBe('2025-06-01T00:00:00.000Z');
      expect(body.data.role).toBe('USER');
      // DB was actually queried for this ID (not short-circuited by auth guard)
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SELF_USER_ID } })
      );
    });
  });

  describe('Happy path', () => {
    it('should return 200 with user envelope when admin fetches any user, and no password field in body', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const fixture = makeUserFixture();
      vi.mocked(prisma.user.findUnique).mockResolvedValue(fixture);
      const request = makeGetRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await GET(request, context);

      // Assert — status first
      expect(response.status).toBe(200);
      const body = await parseResponse<{
        success: boolean;
        data: Record<string, unknown>;
      }>(response);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(body.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      expect(body.data.id).toBe(TARGET_USER_ID);
      expect(body.data.email).toBe('target@example.com');
      // The handler uses a `select` that excludes `password` — confirm the contract
      // is enforced: no password field present in the response data.
      expect(body.data).not.toHaveProperty('password');
    });

    it('should return 404 with NOT_FOUND envelope when the target user does not exist', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      const request = makeGetRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await GET(request, context);

      // Assert — status first
      expect(response.status).toBe(404);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });
});

describe('PATCH /api/v1/users/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    // Default to a valid fixture so tests that override findUnique+update independently
    // don't receive undefined from update and produce a garbled response body.
    vi.mocked(prisma.user.update).mockResolvedValue(makeUserFixture());
  });

  describe('Auth boundary (withAdminAuth)', () => {
    it('should return 401 with UNAUTHORIZED envelope on unauthenticated PATCH, and not call DB', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = makePatchRequest(TARGET_USER_ID, { name: 'New Name' });
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert — status first
      expect(response.status).toBe(401);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 403 with FORBIDDEN envelope when non-admin sends PATCH, and not call DB', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockAuthSession({
          user: {
            id: ADMIN_USER_ID,
            email: 'regular@example.com',
            name: 'Regular User',
            emailVerified: true,
            image: null,
            role: 'USER',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
      );
      const request = makePatchRequest(TARGET_USER_ID, { name: 'Attempted Update' });
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert — status first
      expect(response.status).toBe(403);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  describe('Happy path + DB readback', () => {
    it('should return 200 with updated user and DB readback proves the row was mutated', async () => {
      // Arrange — provide an existing user and an updated version with a later updatedAt.
      // The difference in updatedAt between the DB fixture and the update return value proves
      // the handler wrote to the DB and returned the server-generated timestamp, not just
      // echoing the request body.
      //
      // Fake timers are scoped to this test only so siblings aren't affected.
      // afterUpdatedAt is derived from the fake clock rather than a hardcoded literal,
      // preventing calendar drift when the real date rolls past the hardcoded value.
      try {
        vi.useFakeTimers({ now: new Date('2026-04-19T12:00:00.000Z') });
        const beforeUpdatedAt = new Date('2025-01-01T00:00:00.000Z');
        const afterUpdatedAt = new Date(); // == faked now: 2026-04-19T12:00:00.000Z

        vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
        vi.mocked(prisma.user.findUnique).mockResolvedValue(
          makeUserFixture({ updatedAt: beforeUpdatedAt })
        );
        vi.mocked(prisma.user.update).mockResolvedValue(
          makeUserFixture({ name: 'Updated Name', updatedAt: afterUpdatedAt })
        );

        const request = makePatchRequest(TARGET_USER_ID, { name: 'Updated Name' });
        const context = makeContext(TARGET_USER_ID);

        // Act
        const response = await PATCH(request, context);

        // Assert — status first
        expect(response.status).toBe(200);
        const body = await parseResponse<{
          success: boolean;
          data: { updatedAt: string; name: string };
        }>(response);
        // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
        // test-review:accept tobe_true — structural boolean assertion on API response field
        expect(body.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
        // DB-state readback: updatedAt in the response comes from the update return value,
        // not from the request body — proving the handler actually persisted the change.
        expect(new Date(body.data.updatedAt).getTime()).toBe(afterUpdatedAt.getTime());
        expect(new Date(body.data.updatedAt).getTime()).not.toBe(beforeUpdatedAt.getTime());
        // Also confirm the update was called with the body fields
        expect(prisma.user.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: TARGET_USER_ID },
            data: expect.objectContaining({ name: 'Updated Name' }),
          })
        );
      } finally {
        // Restore real timers in finally so siblings are not left under fake timers
        // even if an assertion above throws.
        vi.useRealTimers();
      }
    });
  });

  describe('Business rule: SELF_ROLE_CHANGE', () => {
    it('should return 400 with SELF_ROLE_CHANGE envelope when admin demotes themselves, and not call update', async () => {
      // Arrange — session user ID matches the target ID (admin editing their own record)
      // with a body requesting a role change away from ADMIN.
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockAuthSession({
          user: {
            id: TARGET_USER_ID, // Admin IS the target
            email: 'admin@example.com',
            name: 'Admin User',
            emailVerified: true,
            image: null,
            role: 'ADMIN',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
      );
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeUserFixture({ id: TARGET_USER_ID, role: 'ADMIN' })
      );

      const request = makePatchRequest(TARGET_USER_ID, { role: 'USER' });
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert — status first, then full error envelope
      expect(response.status).toBe(400);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('SELF_ROLE_CHANGE');
      // Proves the guard prevented the DB write
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  describe('Business rule: SERVICE account is immutable', () => {
    it('should return 400 CANNOT_MODIFY_SYSTEM_ACCOUNT when PATCHing the SERVICE config-owner, and not call update', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeUserFixture({ role: 'ADMIN', accountType: 'SERVICE' })
      );

      const request = makePatchRequest(TARGET_USER_ID, { role: 'USER' });
      const response = await PATCH(request, makeContext(TARGET_USER_ID));

      expect(response.status).toBe(400);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CANNOT_MODIFY_SYSTEM_ACCOUNT');
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });
  });

  describe('Validation', () => {
    it('should return 400 with VALIDATION_ERROR envelope for empty body, and not call DB', async () => {
      // Arrange — real validation path runs (not mocked) per integration-test rules.
      // An empty body `{}` fails the "at least one field must be provided" check at source L111-L113.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const request = makePatchRequest(TARGET_USER_ID, {});
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert — status first
      expect(response.status).toBe(400);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      // Proves handler short-circuited before any DB access
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 400 with VALIDATION_ERROR envelope for invalid ID format, and not call DB', async () => {
      // Arrange — 'not-a-cuid' fails the userIdSchema (z.cuid() pattern) at source L103
      // before any body parsing or DB access.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const request = makePatchRequest('not-a-cuid', { name: 'x' });
      const context = makeContext('not-a-cuid');

      // Act
      const response = await PATCH(request, context);

      // Assert — status first, then full error envelope
      expect(response.status).toBe(400);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      // ID validation fires before any DB access
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 500 with INTERNAL_ERROR envelope when prisma.user.update rejects after a successful findUnique', async () => {
      // Arrange — findUnique succeeds (user exists), then update throws a DB error.
      // This exercises the handler's unhandled-exception path for a write failure.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUserFixture());
      vi.mocked(prisma.user.update).mockRejectedValue(new Error('DB write failure'));

      const request = makePatchRequest(TARGET_USER_ID, { name: 'Updated Name' });
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert — status first, then full error envelope
      expect(response.status).toBe(500);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      // Proves update was attempted (unlike the findUnique-null / 404 path)
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('should return 404 with NOT_FOUND envelope when PATCH targets a non-existent user', async () => {
      // Arrange — valid ID format but user does not exist in the DB.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const request = makePatchRequest(TARGET_USER_ID, { name: 'x' });
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert — status first, then full error envelope
      expect(response.status).toBe(404);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      // User doesn't exist — update must not have been called
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });
});

describe('DELETE /api/v1/users/:id', () => {
  /**
   * Shared receipt fixture for the happy-path $transaction mock.
   * The real eraseUser returns { receiptId, erasedAt } from this row.
   */
  const RECEIPT_FIXTURE = {
    id: 'receipt-cuid-0000000000000001',
    subjectUserId: TARGET_USER_ID,
    subjectEmailHash: 'abc123',
    actorUserId: ADMIN_USER_ID,
    reason: 'admin_action' as const,
    erasedAt: new Date('2026-05-25T10:00:00.000Z'),
    createdAt: new Date('2026-05-25T10:00:00.000Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish defaults after clearAllMocks. clearAllMocks resets call history
    // but NOT mockResolvedValue implementations — explicit re-application ensures
    // per-test isolation regardless of execution order.
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    // Default $transaction: invoke the callback with the mocked prisma client as `tx`.
    // This makes tx.aiAdminAuditLog / tx.dataErasureReceipt / tx.user resolve through
    // the same vi.fn() spies — a no-op mock would make all downstream assertions vacuous.
    vi.mocked(prisma.$transaction).mockImplementation(
      async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)
    );

    // Default sub-transaction collaborators — each test can override per-case.
    vi.mocked(prisma.aiAdminAuditLog.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.dataErasureReceipt.create).mockResolvedValue(RECEIPT_FIXTURE as never);
    vi.mocked(prisma.user.delete).mockResolvedValue(undefined as never);
  });

  describe('Auth boundary (withAdminAuth)', () => {
    it('should return 401 with UNAUTHORIZED envelope on unauthenticated DELETE, and not call DB', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = makeDeleteRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert — status first
      expect(response.status).toBe(401);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      // withAdminAuth short-circuited before any DB call
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 403 with FORBIDDEN envelope when non-admin sends DELETE, and not call DB', async () => {
      // Arrange — authenticated as USER (not ADMIN), so withAdminAuth rejects.
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockAuthSession({
          user: {
            id: ADMIN_USER_ID,
            email: 'regular@example.com',
            name: 'Regular User',
            emailVerified: true,
            image: null,
            role: 'USER',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
      );
      const request = makeDeleteRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert — status first
      expect(response.status).toBe(403);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
      // Role check fired; no DB operation should have been attempted
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  describe('Happy path — real eraseUser over mocked Prisma boundary', () => {
    it('should return 200 and run the full erase flow: receipt create, audit scrub, user delete via $transaction', async () => {
      // Arrange — admin deletes a USER target (not self, not another admin).
      // eraseUser is NOT mocked — the real function runs through the mocked Prisma boundary.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUserFixture({ role: 'USER' }));

      const request = makeDeleteRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert — status first (brittle-patterns rule: status before body)
      expect(response.status).toBe(200);
      const body = await parseResponse<{
        success: boolean;
        data: { id: string; deleted: boolean };
      }>(response);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      expect(body.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      // The handler returns { id, deleted: true } — not a DB row echo.
      expect(body.data).toEqual({ id: TARGET_USER_ID, deleted: true });

      // ---- DB-state readback: prove the real eraseUser ran its $transaction flow ----

      // 1. $transaction was invoked (i.e. eraseUser reached the atomic-commit step)
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // 2. Residual-PII scrub: clientIp nulled on retained audit rows for this user
      expect(prisma.aiAdminAuditLog.updateMany).toHaveBeenCalledWith({
        where: { userId: TARGET_USER_ID },
        data: { clientIp: null },
      });

      // 3. Erasure receipt written (GDPR Art. 5(2) accountability)
      expect(prisma.dataErasureReceipt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subjectUserId: TARGET_USER_ID,
            actorUserId: ADMIN_USER_ID,
            reason: 'admin_action',
          }),
        })
      );

      // 4. User row deleted with the correct where clause — targets the right row
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: TARGET_USER_ID },
      });
    });
  });

  describe('Business rules', () => {
    it('should return 400 CANNOT_DELETE_SELF when admin deletes their own account, and not run erase', async () => {
      // Arrange — session admin and target are the SAME id (self-deletion).
      // mockAdminUser() returns a session with user.id === ADMIN_USER_ID.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const request = makeDeleteRequest(ADMIN_USER_ID);
      const context = makeContext(ADMIN_USER_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert — status first, then full error envelope
      expect(response.status).toBe(400);
      const body = await parseResponse<{
        success: boolean;
        error: { code: string; message: string };
      }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CANNOT_DELETE_SELF');
      expect(body.error.message).toBe('Cannot delete your own account');

      // The self-guard short-circuits BEFORE the existence check — no erase should run.
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 400 CANNOT_DELETE_ADMIN with exact message when target is an ADMIN, and not run erase', async () => {
      // Arrange — target user is an admin (role: 'ADMIN').
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUserFixture({ role: 'ADMIN' }));

      const request = makeDeleteRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert — status first, then full error envelope
      expect(response.status).toBe(400);
      const body = await parseResponse<{
        success: boolean;
        error: { code: string; message: string };
      }>(response);
      expect(body.success).toBe(false);
      // Source route.ts: code: 'CANNOT_DELETE_ADMIN' (asserted explicitly so a regression removing the code is caught)
      expect(body.error.code).toBe('CANNOT_DELETE_ADMIN');
      // Source route.ts: exact message string
      expect(body.error.message).toBe('Cannot delete an admin account. Demote the user first.');
      // Admin-target guard fired; erase must not have run
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 400 CANNOT_DELETE_SYSTEM_ACCOUNT when target is the SERVICE config-owner, and not run erase', async () => {
      // Arrange — target is the non-login SERVICE config-owner.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeUserFixture({ role: 'ADMIN', accountType: 'SERVICE' })
      );

      const response = await DELETE(makeDeleteRequest(TARGET_USER_ID), makeContext(TARGET_USER_ID));

      expect(response.status).toBe(400);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CANNOT_DELETE_SYSTEM_ACCOUNT');
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });

    it('should return 404 with NOT_FOUND envelope when DELETE targets a non-existent user', async () => {
      // Arrange — valid ID format but user does not exist in DB.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const request = makeDeleteRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert — status first, then full error envelope
      expect(response.status).toBe(404);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      // Existence check fired but no erase transaction should have run
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 400 with VALIDATION_ERROR envelope for invalid DELETE ID format, and not call DB', async () => {
      // Arrange — 'not-a-cuid' fails the userIdSchema before the self-delete guard or any DB access.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const request = makeDeleteRequest('not-a-cuid');
      const context = makeContext('not-a-cuid');

      // Act
      const response = await DELETE(request, context);

      // Assert — status first, then full error envelope
      expect(response.status).toBe(400);
      const body = await parseResponse<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      // ID validation fires before any DB access
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.$transaction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });
});
