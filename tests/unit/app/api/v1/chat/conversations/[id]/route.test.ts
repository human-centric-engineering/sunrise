/**
 * Unit Tests: GET /api/v1/chat/conversations/:id
 *             DELETE /api/v1/chat/conversations/:id
 *
 * Tests the single-conversation endpoints. Both handlers are scoped to the
 * caller's own conversations with publicly visible agents. Missing or
 * unauthorized conversations always return 404 (not 403) to avoid
 * confirming resource existence.
 *
 * Test Coverage:
 * - GET: happy path — returns conversation owned by user with public agent
 * - GET: not found — conversation doesn't exist → 404
 * - GET: not found — conversation owned by another user → 404
 * - GET: not found — conversation with internal/inactive agent → 404
 * - GET: invalid CUID format → 400 VALIDATION_ERROR
 * - DELETE: happy path — deletes own conversation → { deleted: true }
 * - DELETE: not found — doesn't own conversation → 404
 * - DELETE: rate limited → 429
 * - DELETE: invalid CUID format → 400 VALIDATION_ERROR
 * - Authentication: no session → 401 (delegated to withAuth)
 *
 * @see app/api/v1/chat/conversations/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, DELETE } from '@/app/api/v1/chat/conversations/[id]/route';
import type { NextRequest } from 'next/server';

/**
 * Mock dependencies
 *
 * getRouteLogger is mocked globally in tests/setup.ts.
 * next/headers is mocked globally in tests/setup.ts.
 */

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// Mock auth config (needed by withAuth guard)
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Mock rate limiters
vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: {
    check: vi.fn(),
  },
  createRateLimitResponse: vi.fn(() =>
    Response.json(
      { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' } },
      { status: 429 }
    )
  ),
}));

// Mock IP utility
vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

/**
 * Response type interfaces
 */
interface SuccessResponseBody<T = unknown> {
  success: true;
  data: T;
}

interface ErrorResponseBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

/**
 * A valid CUID (matches the /^c[^\s-]{8,}$/ pattern)
 */
const VALID_CUID = 'clh3z8q0v0000356i0n2v3g8k';

/**
 * Helper: create a mock NextRequest
 */
function createMockRequest(headers: Record<string, string> = {}): NextRequest {
  const url = new URL(`http://localhost:3000/api/v1/chat/conversations/${VALID_CUID}`);
  return {
    json: async () => ({}),
    headers: new Headers(headers),
    url: url.toString(),
    nextUrl: { searchParams: url.searchParams },
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

/**
 * Helper: build route context with async params
 */
function createRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Helper: parse JSON from a Response
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Helper: build a rate-limit result
 */
function makeRateLimitResult(success: boolean) {
  return {
    success,
    limit: 60,
    remaining: success ? 59 : 0,
    reset: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * Helper: create a mock auth session
 */
function createMockSession(userId = 'user_test123') {
  return {
    session: {
      id: 'session_test123',
      userId,
      token: 'mock_token',
      expiresAt: new Date(Date.now() + 86400000),
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: userId,
      name: 'Test User',
      email: 'test@example.com',
      emailVerified: true,
      image: null,
      role: 'USER' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

/**
 * Mock conversation record
 */
function makeMockConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_CUID,
    userId: 'user_test123',
    agentId: 'agent-001',
    title: 'Test conversation',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T12:00:00.000Z'),
    agent: { id: 'agent-001', name: 'Helper Bot', slug: 'helper-bot' },
    _count: { messages: 3 },
    ...overrides,
  };
}

// =============================================================================
// GET /api/v1/chat/conversations/:id
// =============================================================================

describe('GET /api/v1/chat/conversations/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession() as never);
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeMockConversation() as never);
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------

  describe('Happy path', () => {
    it('should return the conversation with agent details', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await GET(request, context);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({ id: VALID_CUID });
    });

    it('should scope the query to the authenticated user and public+active agent', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      await GET(request, context);

      // Assert
      expect(prisma.aiConversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: VALID_CUID,
            userId: 'user_test123',
            agent: { visibility: { in: ['public', 'invite_only'] }, isActive: true },
          },
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Not found
  // ---------------------------------------------------------------------------

  describe('Not found', () => {
    it('should return 404 when conversation does not exist', async () => {
      // Arrange
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await GET(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('should return 404 when conversation exists but is owned by another user', async () => {
      // Arrange: Prisma returns null because userId filter excludes other users
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await GET(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert: 404 not 403 — avoids confirming resource exists
      expect(response.status).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('should return 404 when agent has internal visibility', async () => {
      // Arrange: visibility filter excludes internal agents → null
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await GET(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Validation errors
  // ---------------------------------------------------------------------------

  describe('Validation errors', () => {
    it('should return 400 when id is not a valid CUID', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext('not-a-cuid');

      // Act
      const response = await GET(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(prisma.aiConversation.findFirst).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Authentication
  // ---------------------------------------------------------------------------

  describe('Authentication', () => {
    it('should return 401 when there is no active session', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await GET(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(prisma.aiConversation.findFirst).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// DELETE /api/v1/chat/conversations/:id
// =============================================================================

describe('DELETE /api/v1/chat/conversations/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession() as never);
    vi.mocked(apiLimiter.check).mockReturnValue(makeRateLimitResult(true));
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeMockConversation() as never);
    vi.mocked(prisma.aiConversation.delete).mockResolvedValue({} as never);
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------

  describe('Happy path', () => {
    it('should delete the conversation and return { deleted: true }', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await DELETE(request, context);
      const body = await parseResponse<SuccessResponseBody<{ deleted: boolean }>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.deleted).toBe(true);

      // Assert: delete was called with the correct id
      expect(prisma.aiConversation.delete).toHaveBeenCalledWith({ where: { id: VALID_CUID } });
    });

    it('should scope the ownership check to the authenticated user', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      await DELETE(request, context);

      // Assert: findFirst checks userId and visibility
      expect(prisma.aiConversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: VALID_CUID,
            userId: 'user_test123',
            agent: { visibility: { in: ['public', 'invite_only'] }, isActive: true },
          },
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Not found
  // ---------------------------------------------------------------------------

  describe('Not found', () => {
    it('should return 404 when conversation does not belong to user', async () => {
      // Arrange
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await DELETE(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(prisma.aiConversation.delete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Rate limiting
  // ---------------------------------------------------------------------------

  describe('Rate limiting', () => {
    it('should return 429 when the IP rate limit is exceeded', async () => {
      // Arrange
      vi.mocked(apiLimiter.check).mockReturnValue(makeRateLimitResult(false));
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await DELETE(request, context);

      // Assert
      expect(response.status).toBe(429);
      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(prisma.aiConversation.findFirst).not.toHaveBeenCalled();
      expect(prisma.aiConversation.delete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Validation errors
  // ---------------------------------------------------------------------------

  describe('Validation errors', () => {
    it('should return 400 when id is not a valid CUID', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext('bad-id');

      // Act
      const response = await DELETE(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(prisma.aiConversation.delete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Authentication
  // ---------------------------------------------------------------------------

  describe('Authentication', () => {
    it('should return 401 when there is no active session', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await DELETE(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(prisma.aiConversation.delete).not.toHaveBeenCalled();
    });
  });
});
