/**
 * Unit Tests: DELETE /api/v1/users/me
 *
 * Covers the DELETE handler's contract:
 *   - Confirmation validation gate
 *   - Last-admin guard (role ADMIN + count <= 1 → 400 LAST_ADMIN)
 *   - Admin but not last → eraseUser called, 200
 *   - Non-admin self-delete → eraseUser called, 200
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
  },
}));

// eraseUser — mock so real PII-scrubbing logic is never run in unit tests.
// Returns a minimal EraseUserResult so callers that await the value don't fail.
vi.mock('@/lib/privacy/erase-user', () => ({
  eraseUser: vi.fn().mockResolvedValue({ receiptId: 'receipt-1', erasedAt: new Date() }),
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
// identity guard above means this path is not reached, but kept for safety
vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

// ---------------------------------------------------------------------------
// Module imports (after mock declarations)
// ---------------------------------------------------------------------------

import { prisma } from '@/lib/db/client';
import { SYSTEM_USER_EMAIL } from '@/lib/auth/constants';
import { eraseUser } from '@/lib/privacy/erase-user';
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

  it('returns a validation error and does NOT call eraseUser when confirmation is absent', async () => {
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

    // Anti-green-bar: eraseUser must NOT have been invoked — confirms the route
    // short-circuits before reaching the erasure step
    expect(eraseUser).not.toHaveBeenCalled();
  });

  it('returns a validation error and does NOT call eraseUser when confirmation value is wrong', async () => {
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

    // eraseUser not called on validation failure
    expect(eraseUser).not.toHaveBeenCalled();
  });

  // ── Case 2: Last-admin block ─────────────────────────────────────────────

  it('returns 400 LAST_ADMIN and does NOT call eraseUser when the sole admin tries to self-delete', async () => {
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
    // The seeded non-login SYSTEM config-owner is excluded from the count so it
    // is not mistaken for a real operator (issue #278 / security review).
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { role: 'ADMIN', email: { not: SYSTEM_USER_EMAIL } },
    });

    // eraseUser must NOT have been called — confirms the guard short-circuits
    expect(eraseUser).not.toHaveBeenCalled();
  });

  it('counts the lone human admin as the last admin even though a system ADMIN row exists (excludes system owner)', async () => {
    // Arrange — a single human admin plus the seeded system owner. The guard's
    // count query excludes the system email, so it returns 1 (the human only)
    // and the human is correctly blocked from self-deleting. Without the
    // exclusion the count would be 2 and the last human admin could delete
    // themselves, reopening the first-user-is-admin bootstrap.
    const session = mockAdminUser();
    // The mock returns whatever count() resolves; we assert the QUERY excludes
    // the system owner, which is what makes a 2-row (system+human) DB report 1.
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
      where: { role: 'ADMIN', email: { not: SYSTEM_USER_EMAIL } },
    });
    expect(eraseUser).not.toHaveBeenCalled();
  });

  // ── Case 3: Admin but not last ──────────────────────────────────────────

  it('calls eraseUser with self_service args and returns { deleted: true } when admin is not the last', async () => {
    // Arrange — ADMIN role, count returns 2 (another admin exists)
    const session = mockAdminUser();
    // Override to get stable userId / email from the mock
    const userId = session.user.id;
    const userEmail = session.user.email;

    vi.mocked(prisma.user.count).mockResolvedValue(2);
    vi.mocked(eraseUser).mockResolvedValue({ receiptId: 'receipt-1', erasedAt: new Date() });

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

    // Anti-green-bar: eraseUser called exactly once with the right args —
    // proves the route computed actorUserId === userId (self-service) and
    // reason === 'self_service' rather than forwarding incorrect values
    expect(eraseUser).toHaveBeenCalledTimes(1);
    expect(eraseUser).toHaveBeenCalledWith({
      userId,
      userEmail,
      actorUserId: userId,
      reason: 'self_service',
    });
  });

  // ── Case 4: Non-admin self-delete ────────────────────────────────────────

  it('calls eraseUser without consulting the count gate and returns { deleted: true } for a USER role', async () => {
    // Arrange — USER role; the admin count gate must NOT be invoked
    const session = buildUserSession('USER');
    const userId = session.user.id;
    const userEmail = session.user.email;

    vi.mocked(eraseUser).mockResolvedValue({ receiptId: 'receipt-1', erasedAt: new Date() });

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

    // eraseUser called with correct self-service payload
    expect(eraseUser).toHaveBeenCalledTimes(1);
    expect(eraseUser).toHaveBeenCalledWith({
      userId,
      userEmail,
      actorUserId: userId,
      reason: 'self_service',
    });
  });

  // ── Case 5: Cookie teardown ──────────────────────────────────────────────

  it('deletes and expires all better-auth cookies after a successful erase', async () => {
    // Arrange — USER role for simplicity; cookie teardown is the same for all roles
    const session = buildUserSession('USER');
    vi.mocked(eraseUser).mockResolvedValue({ receiptId: 'receipt-1', erasedAt: new Date() });

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
    vi.mocked(eraseUser).mockResolvedValue({ receiptId: 'receipt-1', erasedAt: new Date() });

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
      bio: null,
      phone: null,
      timezone: 'UTC',
      location: null,
      preferences: null,
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
      bio: null,
      phone: null,
      timezone: 'UTC',
      location: null,
      preferences: null,
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
