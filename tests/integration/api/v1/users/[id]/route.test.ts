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
 * DELETE /api/v1/users/:id:
 * - 401 unauthenticated (withAdminAuth guard)
 * - 403 non-admin
 * - 200 + prisma.user.delete called with correct where clause
 * - 400 admin-delete-admin blocked
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
vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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
 * Fields match the select shape in the GET handler.
 */
function makeUserFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_USER_ID,
    name: 'Target User',
    email: 'target@example.com',
    role: 'USER',
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
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('should return 403 with FORBIDDEN envelope when non-admin requests another user profile, and not call DB', async () => {
      // Arrange — authenticated as a regular USER whose ID differs from the target
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockAuthSession({
          user: {
            id: ADMIN_USER_ID, // Different from TARGET_USER_ID
            email: 'user-a@example.com',
            name: 'User A',
            emailVerified: true,
            image: null,
            role: 'USER',
            createdAt: new Date(),
            updatedAt: new Date(),
            bio: null,
            phone: null,
            timezone: 'UTC',
            location: null,
            preferences: {},
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
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
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
            bio: null,
            phone: null,
            timezone: 'UTC',
            location: null,
            preferences: {},
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
      expect(body.success).toBe(true);
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
      expect(body.success).toBe(true);
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
    vi.mocked(prisma.user.update).mockResolvedValue(undefined as never);
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
      expect(prisma.user.update).not.toHaveBeenCalled();
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
            bio: null,
            phone: null,
            timezone: 'UTC',
            location: null,
            preferences: {},
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
      expect(prisma.user.update).not.toHaveBeenCalled();
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
      expect(body.success).toBe(true);
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

      // Restore real timers — scoped cleanup prevents siblings from running under fake timers.
      vi.useRealTimers();
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
            bio: null,
            phone: null,
            timezone: 'UTC',
            location: null,
            preferences: {},
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
      expect(prisma.user.update).not.toHaveBeenCalled();
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
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });
});

describe('DELETE /api/v1/users/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
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
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('should return 403 with FORBIDDEN envelope when non-admin sends DELETE, and not call DB', async () => {
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
            bio: null,
            phone: null,
            timezone: 'UTC',
            location: null,
            preferences: {},
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
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });
  });

  describe('Happy path + DB readback', () => {
    it('should return 200 and invoke prisma.user.delete with correct where clause when admin deletes a non-admin user', async () => {
      // Arrange — admin session with a DIFFERENT id than the target (not self-deletion).
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUserFixture({ role: 'USER' }));
      // delete resolves — the handler doesn't use its return value directly.
      vi.mocked(prisma.user.delete).mockResolvedValue(makeUserFixture() as never);

      const request = makeDeleteRequest(TARGET_USER_ID);
      const context = makeContext(TARGET_USER_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert — status first
      expect(response.status).toBe(200);
      const body = await parseResponse<{
        success: boolean;
        data: { id: string; deleted: boolean };
      }>(response);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ id: TARGET_USER_ID, deleted: true });

      // DB-state readback for DELETE: we cannot read the row back after deletion.
      // Instead, we verify the mutation was issued with the correct `where` clause —
      // this IS the readback contract for a delete operation, proving the handler
      // targeted the right row. No follow-up findUnique is needed or appropriate.
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: TARGET_USER_ID },
      });
    });
  });

  describe('Business rules', () => {
    it('should return 400 CANNOT_DELETE_SELF when admin deletes their own account, and not call delete', async () => {
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

      // The self-guard short-circuits BEFORE the existence check, so neither
      // findUnique nor delete should have been called.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('should return 400 when admin attempts to delete another ADMIN user, and not call delete', async () => {
      // Arrange — target is an admin (role: 'ADMIN')
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
        error: { message: string };
      }>(response);
      expect(body.success).toBe(false);
      // Source L209: "Cannot delete an admin account. Demote the user first."
      expect(body.error.message).toMatch(/admin account/i);
      // Proves the guard prevented the actual DB delete
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });
  });
});
