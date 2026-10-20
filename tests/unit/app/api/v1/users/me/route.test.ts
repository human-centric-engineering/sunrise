/**
 * Unit Tests: DELETE /api/v1/users/me
 *
 * Covers the DELETE handler's contract:
 *   - Confirmation validation gate
 *   - Last-admin guard (role ADMIN + count <= 1 → 400 LAST_ADMIN)
 *   - Admin but not last → requestUserErasure called, 200
 *   - Non-admin self-delete → requestUserErasure called, 200
 *   - Cookie teardown (better-auth + __Secure- cookies cleared after erase)
 *   - Analytics (serverTrack(ACCOUNT_DELETED) fired after success)
 *
 * GET and PATCH are covered lightly to confirm the happy path works under the
 * mock wiring; behavioral depth for those handlers lives in the [id] test file.
 *
 * @see app/api/v1/users/me/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as meRoute from '@/app/api/v1/users/me/route';
import { createMockRequest } from '@/tests/helpers/api';
import { createMockLogger } from '@/tests/types/mocks';
import { mockAuthenticatedUser, mockAdminUser } from '@/tests/helpers/auth';
import { parseJSON } from '@/tests/helpers/assertions';

// Route handlers after withAuth mock produce a (request, session) → Response
// signature. Cast to allow 2-arg calls throughout this file.
type RouteHandler = (req: Request, session: unknown) => Promise<Response>;
const GET = meRoute.GET as unknown as RouteHandler;
const PATCH = meRoute.PATCH as unknown as RouteHandler;
const DELETE = meRoute.DELETE as unknown as RouteHandler;

// ---------------------------------------------------------------------------
// Mock declarations — all vi.mock calls are hoisted before imports at runtime
// ---------------------------------------------------------------------------

// Auth guard — preserve error handling wrapper but skip the real session lookup.
// The DELETE handler's inner try/catch re-throws on error, so withAuth's outer
// handleAPIError wrapper is required for validation errors to become 400 responses
// rather than uncaught exceptions. We inject the session object as the second arg.
vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session);
      } catch (error) {
        return handleAPIError(error);
      }
    },
  withAdminAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

// next/headers — cookies() returns a mock cookie store
const mockCookieStore = {
  delete: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
};

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => mockCookieStore),
  headers: vi.fn(async () => new Headers()),
}));

// Prisma client — only user.count and user.findUnique are used by DELETE/GET
vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    // PATCH looks up the credential row to decide whether to demand the
    // current password before an email change (#489).
    account: {
      findFirst: vi.fn(),
    },
  },
}));

// better-auth's password verifier — the real one is scrypt over a stored hash,
// which unit tests have no reason to exercise. Default to "correct password";
// individual cases override.
vi.mock('better-auth/crypto', () => ({
  verifyPassword: vi.fn().mockResolvedValue(true),
}));

// requestUserErasure — mock so the claim transaction and the real PII-scrubbing
// logic are never run in unit tests. Returns a finished erasure by default.
vi.mock('@/lib/privacy/erasure-requests', () => ({
  requestUserErasure: vi.fn().mockResolvedValue({
    status: 'erased',
    receiptId: 'receipt-1',
    erasedAt: new Date(),
  }),
}));

// serverTrack — mock; assert it is called with the right event
vi.mock('@/lib/analytics/server', () => ({
  serverTrack: vi.fn().mockResolvedValue(undefined),
}));

// Route logger — always resolves to the mock logger
const mockLog = createMockLogger();

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => mockLog),
}));

// auth config — needed transitively by guards.ts when not mocked; mock the
// identity guard above means this path is not reached, but kept for safety.
// `changeEmail` IS reached: PATCH delegates the email change to it (#489).
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
      sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
      changeEmail: vi.fn().mockResolvedValue({ status: true }),
    },
  },
}));

// ---------------------------------------------------------------------------
// Module imports (after mock declarations)
// ---------------------------------------------------------------------------

import { prisma } from '@/lib/db/client';
import { verifyPassword } from 'better-auth/crypto';
import { auth } from '@/lib/auth/config';
import { humanAdminWhere } from '@/lib/auth/account';
import { requestUserErasure } from '@/lib/privacy/erasure-requests';
import { serverTrack } from '@/lib/analytics/server';
import { EVENTS } from '@/lib/analytics/events';

// ---------------------------------------------------------------------------
// Response type interfaces
// ---------------------------------------------------------------------------

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type ApiBody = SuccessBody | ErrorBody;

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

/** Build the session object that withAuth injects into the handler */
function buildUserSession(role: 'USER' | 'ADMIN' = 'USER') {
  const base = role === 'ADMIN' ? mockAdminUser() : mockAuthenticatedUser('USER');
  return base;
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/users/me
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/users/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Case 1: Missing / invalid confirmation body ─────────────────────────

  it('returns a validation error and does NOT call requestUserErasure when confirmation is absent', async () => {
    // Arrange
    const session = buildUserSession('USER');
    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: {}, // no `confirmation` key
    });

    // Act
    const response = await DELETE(request, session);
    const body = await parseJSON<ApiBody>(response);

    // Assert — validation error returned
    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect((body as ErrorBody).error.code).toBe('VALIDATION_ERROR');

    // Anti-green-bar: requestUserErasure must NOT have been invoked — confirms the route
    // short-circuits before reaching the erasure step
    expect(requestUserErasure).not.toHaveBeenCalled();
  });

  it('returns a validation error and does NOT call requestUserErasure when confirmation value is wrong', async () => {
    // Arrange
    const session = buildUserSession('USER');
    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'delete' }, // lowercase — schema expects exact "DELETE"
    });

    // Act
    const response = await DELETE(request, session);
    const body = await parseJSON<ApiBody>(response);

    // Assert
    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect((body as ErrorBody).error.code).toBe('VALIDATION_ERROR');

    // requestUserErasure not called on validation failure
    expect(requestUserErasure).not.toHaveBeenCalled();
  });

  it('refuses self-deletion inside a support session, before the last-admin check (§121 t-824)', async () => {
    // The guard presents a supporting platform admin as role USER, so the
    // last-admin count would never run for them; the route refuses instead.
    const { runAsOrg } = await import('@/lib/tenancy/context');
    const session = buildUserSession('USER');
    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    const response = await runAsOrg('cmorg00000000000customer1', () => DELETE(request, session), {
      source: 'support',
      role: 'ADMIN',
      support: { grantId: 'grant-1', level: 'ADMIN', expiresAt: new Date(Date.now() + 60_000) },
    });
    const body = await parseJSON<ApiBody>(response);

    expect(response.status).toBe(403);
    expect((body as ErrorBody).error.code).toBe('FORBIDDEN');
    expect(requestUserErasure).not.toHaveBeenCalled();
  });

  // ── Case 2: Last-admin block ─────────────────────────────────────────────

  it('returns 400 LAST_ADMIN and does NOT call requestUserErasure when the sole admin tries to self-delete', async () => {
    // Arrange — ADMIN role, count returns 1 (last admin)
    const session = mockAdminUser();
    vi.mocked(prisma.user.count).mockResolvedValue(1);

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    // Act
    const response = await DELETE(request, session);
    const body = await parseJSON<ApiBody>(response);

    // Assert — 400 with the LAST_ADMIN code
    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect((body as ErrorBody).error.code).toBe('LAST_ADMIN');

    // The count gate was consulted — verifies the route performs the DB check.
    // It counts only real human admins (`humanAdminWhere`): the seeded SERVICE
    // config-owner has role ADMIN but is excluded, so it cannot be mistaken for
    // a real operator (issue #278 / security review).
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        ...humanAdminWhere,
        OR: [{ erasureRequestedAt: null }, { id: session.user.id }],
      },
    });

    // requestUserErasure must NOT have been called — confirms the guard short-circuits
    expect(requestUserErasure).not.toHaveBeenCalled();
  });

  it('counts the lone human admin as the last admin even though a system ADMIN row exists (excludes SERVICE account)', async () => {
    // Arrange — a single human admin plus the seeded SERVICE config-owner. The
    // guard's count query filters on `accountType: 'HUMAN'`, so it returns 1
    // (the human only) and the human is correctly blocked from self-deleting.
    // Without the exclusion the count would be 2 and the last human admin could
    // delete themselves, reopening the first-user-is-admin bootstrap.
    const session = mockAdminUser();
    // The mock returns whatever count() resolves; we assert the QUERY excludes
    // the SERVICE account, which is what makes a 2-row (system+human) DB report 1.
    vi.mocked(prisma.user.count).mockResolvedValue(1);

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    const response = await DELETE(request, session);
    const body = await parseJSON<ApiBody>(response);

    expect(response.status).toBe(400);
    expect((body as ErrorBody).error.code).toBe('LAST_ADMIN');
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        ...humanAdminWhere,
        OR: [{ erasureRequestedAt: null }, { id: session.user.id }],
      },
    });
    expect(requestUserErasure).not.toHaveBeenCalled();
  });

  // ── Case 3: Admin but not last ──────────────────────────────────────────

  it('calls requestUserErasure with self_service args and returns { deleted: true } when admin is not the last', async () => {
    // Arrange — ADMIN role, count returns 2 (another admin exists)
    const session = mockAdminUser();
    // Override to get stable userId / email from the mock
    const userId = session.user.id;

    vi.mocked(prisma.user.count).mockResolvedValue(2);
    vi.mocked(requestUserErasure).mockResolvedValue({
      status: 'erased',
      receiptId: 'receipt-1',
      erasedAt: new Date(),
    });

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    // Act
    const response = await DELETE(request, session);
    const body = await parseJSON<SuccessBody>(response);

    // Assert — successful deletion
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Anti-green-bar: requestUserErasure called exactly once with the right args —
    // proves the route computed actorUserId === userId (self-service) and
    // reason === 'self_service' rather than forwarding incorrect values
    expect(requestUserErasure).toHaveBeenCalledTimes(1);
    // No `userEmail`: it is deprecated, and the receipt reads the stored
    // address instead of the session's possibly stale copy (t-797).
    expect(requestUserErasure).toHaveBeenCalledWith({
      userId,
      actorUserId: userId,
      reason: 'self_service',
    });
  });

  // ── Case 4: Non-admin self-delete ────────────────────────────────────────

  it('calls requestUserErasure without consulting the count gate and returns { deleted: true } for a USER role', async () => {
    // Arrange — USER role; the admin count gate must NOT be invoked
    const session = buildUserSession('USER');
    const userId = session.user.id;

    vi.mocked(requestUserErasure).mockResolvedValue({
      status: 'erased',
      receiptId: 'receipt-1',
      erasedAt: new Date(),
    });

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    // Act
    const response = await DELETE(request, session);
    const body = await parseJSON<SuccessBody>(response);

    // Assert — successful deletion
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Count gate skipped for non-admins
    expect(prisma.user.count).not.toHaveBeenCalled();

    // requestUserErasure called with correct self-service payload
    expect(requestUserErasure).toHaveBeenCalledTimes(1);
    // No `userEmail`: it is deprecated, and the receipt reads the stored
    // address instead of the session's possibly stale copy (t-797).
    expect(requestUserErasure).toHaveBeenCalledWith({
      userId,
      actorUserId: userId,
      reason: 'self_service',
    });
  });

  // ── Case 4b: Erasure already in progress ─────────────────────────────────

  it('returns 409 CONFLICT, clears the cookies and tracks nothing when another attempt holds the erasure', async () => {
    const session = buildUserSession('USER');
    vi.mocked(requestUserErasure).mockResolvedValue({
      status: 'in_progress',
      requestedAt: new Date('2026-10-19T10:00:00Z'),
    });

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    const response = await DELETE(request, session);
    const body = await parseJSON<ApiBody>(response);

    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect((body as ErrorBody).error.code).toBe('CONFLICT');
    expect(requestUserErasure).toHaveBeenCalledTimes(1);
    // Its sessions are gone either way, so the cookies go too; but the account
    // is not yet erased, so nothing reports it deleted.
    expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_token');
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      '__Secure-better-auth.session_data',
      '',
      expect.objectContaining({ maxAge: 0 })
    );
    expect(serverTrack).not.toHaveBeenCalled();
  });

  // ── Case 4c: Erasure did not finish within the request budget (t-845) ────

  it('returns 202 { pending: true, requestedAt } instead of the deleted body when the erasure is still pending', async () => {
    const session = buildUserSession('USER');
    vi.mocked(requestUserErasure).mockResolvedValue({
      status: 'pending',
      requestedAt: new Date('2026-10-20T11:59:55.000Z'),
    });

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    const response = await DELETE(request, session);
    const body = await parseJSON<SuccessBody>(response);

    expect(response.status).toBe(202);
    expect(body).toEqual({
      success: true,
      data: { pending: true, requestedAt: '2026-10-20T11:59:55.000Z' },
    });
    // Not reported as done: the client tells the two apart by these keys.
    expect(body.data).not.toHaveProperty('deleted');
    expect(requestUserErasure).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith(
      'User account deletion pending; the maintenance tick finishes it'
    );
    expect(mockLog.info).not.toHaveBeenCalledWith('User account deleted successfully');
  });

  it('still clears all the auth cookies on a pending answer, since the account’s sessions are gone', async () => {
    const session = buildUserSession('USER');
    vi.mocked(requestUserErasure).mockResolvedValue({
      status: 'pending',
      requestedAt: new Date('2026-10-20T11:59:55.000Z'),
    });

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    const response = await DELETE(request, session);

    expect(response.status).toBe(202);
    expect(mockCookieStore.delete).toHaveBeenCalledTimes(4);
    expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_token');
    expect(mockCookieStore.set).toHaveBeenCalledTimes(4);
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      '__Secure-better-auth.session_token',
      '',
      expect.objectContaining({ maxAge: 0 })
    );
  });

  // ── Case 5: Cookie teardown ──────────────────────────────────────────────

  it('deletes and expires all better-auth cookies after a successful erase', async () => {
    // Arrange — USER role for simplicity; cookie teardown is the same for all roles
    const session = buildUserSession('USER');
    vi.mocked(requestUserErasure).mockResolvedValue({
      status: 'erased',
      receiptId: 'receipt-1',
      erasedAt: new Date(),
    });

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    // Act
    const response = await DELETE(request, session);

    // Pre-assertion: confirm success so cookie assertions are meaningful
    expect(response.status).toBe(200);

    // Assert — the route deletes the four non-Secure cookies
    // Verifies route behavior (explicit calls), not just that cookies() was called
    expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_token');
    expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_data');
    expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.csrf_token');
    expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.state');

    // Assert — __Secure- cookies are expired via set() with maxAge:0 (browsers
    // reject delete() for Secure cookies without the Secure attribute)
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

    // Total call counts: 4 deletes + 4 sets
    expect(mockCookieStore.delete).toHaveBeenCalledTimes(4);
    expect(mockCookieStore.set).toHaveBeenCalledTimes(4);
  });

  // ── Case 6: Analytics ────────────────────────────────────────────────────

  it('fires serverTrack with ACCOUNT_DELETED event after a successful erase', async () => {
    // Arrange
    const session = buildUserSession('USER');
    const userId = session.user.id;
    vi.mocked(requestUserErasure).mockResolvedValue({
      status: 'erased',
      receiptId: 'receipt-1',
      erasedAt: new Date(),
    });

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    // Act
    const response = await DELETE(request, session);

    // Pre-assertion: confirm success
    expect(response.status).toBe(200);

    // Assert — serverTrack called exactly once with the ACCOUNT_DELETED event
    // and the correct userId — proves the route wires the session userId through
    expect(serverTrack).toHaveBeenCalledTimes(1);
    expect(serverTrack).toHaveBeenCalledWith({
      event: EVENTS.ACCOUNT_DELETED,
      userId,
    });
  });

  // ── Cookie teardown does NOT run on validation error ─────────────────────

  it('does NOT clear cookies when validation fails', async () => {
    // Arrange
    const session = buildUserSession('USER');
    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'WRONG' },
    });

    // Act
    await DELETE(request, session);

    // Assert — cookie store untouched on validation error
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
    expect(mockCookieStore.set).not.toHaveBeenCalled();
  });

  // ── Analytics does NOT fire on last-admin block ─────────────────────────

  it('does NOT fire serverTrack when the LAST_ADMIN guard blocks deletion', async () => {
    // Arrange
    const session = mockAdminUser();
    vi.mocked(prisma.user.count).mockResolvedValue(1);

    const request = createMockRequest({
      method: 'DELETE',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { confirmation: 'DELETE' },
    });

    // Act
    const response = await DELETE(request, session);
    expect(response.status).toBe(400);

    // Assert — analytics event must not fire for a blocked deletion
    expect(serverTrack).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/me — light smoke tests to confirm mock wiring
// ---------------------------------------------------------------------------

describe('GET /api/v1/users/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the current user profile wrapped in a success envelope', async () => {
    // Arrange
    const session = buildUserSession('USER');
    const dbUser = {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: true,
      image: null,
      role: 'USER',
      accountType: 'HUMAN' as const,
      bio: null,
      phone: null,
      timezone: 'UTC',
      location: null,
      preferences: null,
      signupOrgId: null,
      signupOrgRole: null,
      erasureRequestedAt: null,
      erasureRequestedBy: null,
      erasureReason: null,
      erasureAttempts: 0,
      erasureNextAttemptAt: null,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    };
    vi.mocked(prisma.user.findUnique).mockResolvedValue(dbUser);

    const request = createMockRequest({
      url: 'http://localhost:3000/api/v1/users/me',
    });

    // Act
    const response = await GET(request, session);
    const body = await parseJSON<SuccessBody>(response);

    // Assert — route wraps the DB row in { success: true, data: {...} }
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    // Confirm route queried the DB with the session's userId
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: session.user.id } })
    );
    // Confirm the response contains the user's identity (not just mock passthrough —
    // the route selects specific fields, so the data shape confirms selection logic)
    expect(body.data.id).toBe(session.user.id);
    expect(body.data.email).toBe(session.user.email);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/users/me — light smoke test to confirm mock wiring
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/users/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates the user profile and returns the updated record in a success envelope', async () => {
    // Arrange
    const session = buildUserSession('USER');
    const updatedUser = {
      id: session.user.id,
      name: 'Updated Name',
      email: session.user.email,
      emailVerified: true,
      image: null,
      role: 'USER',
      accountType: 'HUMAN' as const,
      bio: null,
      phone: null,
      timezone: 'UTC',
      location: null,
      preferences: null,
      signupOrgId: null,
      signupOrgRole: null,
      erasureRequestedAt: null,
      erasureRequestedBy: null,
      erasureReason: null,
      erasureAttempts: 0,
      erasureNextAttemptAt: null,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-06-01'),
    };
    // findUnique returns null for email uniqueness check (no collision)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue(updatedUser);

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { name: 'Updated Name' },
    });

    // Act
    const response = await PATCH(request, session);
    const body = await parseJSON<SuccessBody>(response);

    // Assert — route returns the updated user shape, not the raw mock value
    // (it calls prisma.user.update with select, which shapes the output)
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Updated Name');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: session.user.id },
        data: { name: 'Updated Name' },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/users/me — email change re-verification
// ---------------------------------------------------------------------------

/**
 * `emailVerified` is the platform's assertion that a user controls an address.
 * The PATCH handler used to spread the request body straight into
 * `prisma.user.update`, so an account that had verified one address could
 * become a *verified* holder of any unregistered address in a single request —
 * leaving the flag false in fact while true in the database.
 *
 * That matters wherever the pairing is trusted: invitation redemption that
 * resolves by matching `user.email` hands the invitation's tier to whoever
 * claims the address first, and any allowlist keyed on an email domain can be
 * joined by typing the address.
 */
describe('PATCH /api/v1/users/me — email change', () => {
  const UPDATED_SHAPE = {
    name: 'Test User',
    image: null,
    role: 'USER',
    accountType: 'HUMAN' as const,
    bio: null,
    phone: null,
    timezone: 'UTC',
    location: null,
    preferences: null,
    signupOrgId: null,
    signupOrgRole: null,
    erasureRequestedAt: null,
    erasureRequestedBy: null,
    erasureReason: null,
    erasureAttempts: 0,
    erasureNextAttemptAt: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
  };

  beforeEach(() => {
    // `clearAllMocks` resets calls but NOT implementations, so any case that
    // overrides one of these has to be undone here or it leaks into the next.
    vi.clearAllMocks();
    vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);
    vi.mocked(auth.api.changeEmail).mockResolvedValue({ status: true });
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(prisma.account.findFirst).mockResolvedValue(null);
  });

  // `withAuth` accepts an API key of ANY scope, and keys are self-service. So
  // without a gate a `chat`-scoped key could move the account to an attacker's
  // address — and the verification mail above would hand them a live token,
  // which `autoSignInAfterVerification` turns into a real session. Read-ish
  // scope escalating to account takeover.
  it('refuses an email change from an API-key principal', async () => {
    const session = buildUserSession('USER');
    // resolveApiKey mints session ids with this prefix; isApiKeySession matches it.
    session.session.id = 'apikey_ck_some_key_id';
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { email: 'attacker@evil.com' },
    });

    const response = await PATCH(request, session);

    expect(response.status).toBe(403);
    // Nothing written, and critically no token mailed to the new address.
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(auth.api.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('still lets an API-key principal edit non-identity profile fields', async () => {
    // The gate is scoped to the email path — a key must not lose its legitimate
    // ability to update a profile.
    const session = buildUserSession('USER');
    session.session.id = 'apikey_ck_some_key_id';
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: session.user.id,
      email: session.user.email,
      emailVerified: true,
      ...UPDATED_SHAPE,
    });

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { bio: 'set via api key' },
    });

    const response = await PATCH(request, session);

    expect(response.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('does NOT write the new address directly — it delegates to better-auth', async () => {
    // The heart of #489. Writing the address here is what made one stolen
    // session enough for permanent takeover: it moved immediately, the
    // verification link went to the attacker, and autoSignInAfterVerification
    // turned that into a fresh session. The address must not change until the
    // CURRENT address has approved.
    const session = buildUserSession('USER');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    // Cast: the route `select`s only `password`, so a full Account is not what
    // comes back at runtime.
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ password: 'stored-hash' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: session.user.id,
      email: session.user.email,
      emailVerified: true,
      ...UPDATED_SHAPE,
    });

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { email: 'new@example.com', currentPassword: 'correct-horse' },
    });

    const response = await PATCH(request, session);

    expect(response.status).toBe(200);
    // The Prisma write must carry the profile fields only — never the address.
    const updateArg = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.email).toBeUndefined();
    // ...and `currentPassword` is a credential, not a column.
    expect(updateArg.data.currentPassword).toBeUndefined();

    expect(auth.api.changeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ body: { newEmail: 'new@example.com' } })
    );
  });

  it('reports the change as requested, still returning the OLD address', async () => {
    // The caller must be able to tell that nothing has moved yet, otherwise a
    // UI will happily claim the address was updated.
    const session = buildUserSession('USER');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    // Cast: the route `select`s only `password`, so a full Account is not what
    // comes back at runtime.
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ password: 'stored-hash' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: session.user.id,
      email: session.user.email,
      emailVerified: true,
      ...UPDATED_SHAPE,
    });

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { email: 'new@example.com', currentPassword: 'correct-horse' },
    });

    const body = await parseJSON<SuccessBody>(await PATCH(request, session));

    expect(body.data.emailChangeRequested).toBe(true);
    expect(body.data.email).toBe(session.user.email);
  });

  it('rejects an email change with no current password', async () => {
    const session = buildUserSession('USER');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    // Cast: the route `select`s only `password`, so a full Account is not what
    // comes back at runtime.
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ password: 'stored-hash' } as never);

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { email: 'new@example.com' },
    });

    const response = await PATCH(request, session);

    expect(response.status).toBe(400);
    expect(auth.api.changeEmail).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does not leak whether the target address is registered before the password gate', async () => {
    // A caller holding only a stolen session (no password) must get the
    // IDENTICAL response regardless of whether the address they name happens
    // to be registered — otherwise EMAIL_TAKEN vs. "password required" is a
    // free account-enumeration oracle that needs nothing but a stolen cookie.
    // The uniqueness check must not run before the password gate does.
    const session = buildUserSession('USER');
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ password: 'stored-hash' } as never);
    // The target address IS registered to someone else — if uniqueness ran
    // first, this would surface as EMAIL_TAKEN instead of "password required".
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'someone-else',
      email: 'taken@example.com',
    } as never);

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { email: 'taken@example.com' },
    });

    const response = await PATCH(request, session);
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an email change with the WRONG current password', async () => {
    const session = buildUserSession('USER');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    // Cast: the route `select`s only `password`, so a full Account is not what
    // comes back at runtime.
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ password: 'stored-hash' } as never);
    vi.mocked(verifyPassword).mockResolvedValue(false);

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { email: 'new@example.com', currentPassword: 'wrong' },
    });

    const response = await PATCH(request, session);

    expect(response.status).toBe(403);
    expect(auth.api.changeEmail).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('lets an OAuth-only account change email without a password', async () => {
    // No credential row means there is no password to confirm. Locking these
    // users out of their own email change would be a regression; the approval
    // step at the old address is what actually guards the flow for them.
    const session = buildUserSession('USER');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.account.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: session.user.id,
      email: session.user.email,
      emailVerified: true,
      ...UPDATED_SHAPE,
    });

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { email: 'new@example.com' },
    });

    const response = await PATCH(request, session);

    expect(response.status).toBe(200);
    expect(auth.api.changeEmail).toHaveBeenCalled();
  });

  it('does not ask for a password when the email is not changing', async () => {
    // A name-only edit must not start demanding credentials.
    const session = buildUserSession('USER');
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: session.user.id,
      email: session.user.email,
      emailVerified: true,
      ...UPDATED_SHAPE,
    });

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { name: 'Renamed' },
    });

    const response = await PATCH(request, session);

    expect(response.status).toBe(200);
    expect(prisma.account.findFirst).not.toHaveBeenCalled();
    expect(auth.api.changeEmail).not.toHaveBeenCalled();
  });

  it('does NOT start a change when the submitted email matches the current one', async () => {
    // Forms that PATCH every field re-submit the unchanged address. Treating
    // that as a change would demand a password on an ordinary profile save.
    const session = buildUserSession('USER');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: session.user.id,
      email: session.user.email,
      emailVerified: true,
      ...UPDATED_SHAPE,
    });

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      // Different case, same address — comparison is case-insensitive.
      body: { email: session.user.email.toUpperCase() },
    });

    const response = await PATCH(request, session);

    expect(response.status).toBe(200);
    expect(auth.api.changeEmail).not.toHaveBeenCalled();
    const body = await parseJSON<SuccessBody>(response);
    expect(body.data.emailChangeRequested).toBe(false);
  });

  it('still returns 200 when starting the change throws', async () => {
    // The profile fields are already committed by this point, so a failure to
    // start the email flow must not fail the whole PATCH. The response says
    // `emailChangeRequested: false` so the caller is not misled.
    const session = buildUserSession('USER');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    // Cast: the route `select`s only `password`, so a full Account is not what
    // comes back at runtime.
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ password: 'stored-hash' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: session.user.id,
      email: session.user.email,
      emailVerified: true,
      ...UPDATED_SHAPE,
    });
    vi.mocked(auth.api.changeEmail).mockRejectedValue(new Error('SMTP down'));

    const request = createMockRequest({
      method: 'PATCH',
      url: 'http://localhost:3000/api/v1/users/me',
      body: { email: 'new@example.com', currentPassword: 'correct-horse' },
    });

    const response = await PATCH(request, session);

    expect(response.status).toBe(200);
    const body = await parseJSON<SuccessBody>(response);
    expect(body.data.emailChangeRequested).toBe(false);
  });
});
