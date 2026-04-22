/**
 * Unit Tests: GET /api/v1/chat/conversations
 *
 * Tests the consumer conversations list endpoint. Returns the authenticated
 * user's own conversations, scoped to publicly visible and active agents.
 * Supports optional agentSlug filtering and pagination.
 *
 * Test Coverage:
 * - Happy path: returns user's conversations with pagination metadata
 * - Empty list: user has no conversations → empty array
 * - Filters by agentSlug when provided in query string
 * - Does not return conversations with internal/inactive agents
 * - Authentication: no session → 401 (delegated to withAuth)
 *
 * @see app/api/v1/chat/conversations/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/v1/chat/conversations/route';
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
      findMany: vi.fn(),
      count: vi.fn(),
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

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';

/**
 * Response type interfaces
 */
interface SuccessResponseBody<T = unknown> {
  success: true;
  data: T;
  meta?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface ErrorResponseBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

/**
 * Helper: create a mock NextRequest with optional query params
 */
function createMockRequest(searchParams: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/chat/conversations');
  Object.entries(searchParams).forEach(([k, v]) => url.searchParams.set(k, v));
  return {
    json: async () => ({}),
    headers: new Headers(),
    url: url.toString(),
    nextUrl: { searchParams: url.searchParams },
  } as unknown as NextRequest;
}

/**
 * Helper: parse JSON from a Response
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
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
 * Mock conversation record shape (as returned from Prisma with agent include)
 */
function makeMockConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clh3z8q0v0000356i0n2v3g8k',
    userId: 'user_test123',
    agentId: 'agent-001',
    title: 'Chat about pricing',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T12:00:00.000Z'),
    agent: { id: 'agent-001', name: 'Helper Bot', slug: 'helper-bot' },
    _count: { messages: 5 },
    ...overrides,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('GET /api/v1/chat/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated session
    vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession() as never);

    // Default: no conversations
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------

  describe('Happy path', () => {
    it('should return the user conversations with pagination metadata', async () => {
      // Arrange
      const conversations = [
        makeMockConversation(),
        makeMockConversation({ id: 'clh3z8q0v0001356i0n2v3g8l' }),
      ];
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue(conversations as never);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(2);

      const request = createMockRequest();

      // Act
      const response = await GET(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.meta).toBeDefined();
      expect(body.meta?.total).toBe(2);
    });

    it('should scope query to the authenticated user and public+active agents', async () => {
      // Arrange
      const request = createMockRequest();

      // Act
      await GET(request);

      // Assert: findMany called with user + visibility filters
      expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'user_test123',
            agent: expect.objectContaining({
              visibility: { in: ['public', 'invite_only'] },
              isActive: true,
            }),
          }),
        })
      );
    });

    it('should include agent details in the response', async () => {
      // Arrange
      const conversation = makeMockConversation();
      vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([conversation] as never);
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(1);

      const request = createMockRequest();

      // Act
      const response = await GET(request);
      const body = await parseResponse<SuccessResponseBody<(typeof conversation)[]>>(response);

      // Assert: agent is included in each conversation
      expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            agent: expect.any(Object),
          }),
        })
      );
      expect(body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Empty list
  // ---------------------------------------------------------------------------

  describe('Empty list', () => {
    it('should return an empty array when user has no conversations', async () => {
      // Arrange: defaults already return empty
      const request = createMockRequest();

      // Act
      const response = await GET(request);
      const body = await parseResponse<SuccessResponseBody<unknown[]>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(0);
      expect(body.meta?.total).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. agentSlug filter
  // ---------------------------------------------------------------------------

  describe('agentSlug filter', () => {
    it('should add agentSlug to the where clause when provided', async () => {
      // Arrange
      const request = createMockRequest({ agentSlug: 'helper-bot' });

      // Act
      await GET(request);

      // Assert: the slug filter is included in the agent relation filter
      expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            agent: expect.objectContaining({ slug: 'helper-bot' }),
          }),
        })
      );
    });

    it('should not add agentSlug filter when not provided', async () => {
      // Arrange
      const request = createMockRequest(); // no agentSlug param

      // Act
      await GET(request);

      // Assert: agent filter only has visibility and isActive
      expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            agent: { visibility: { in: ['public', 'invite_only'] }, isActive: true },
          }),
        })
      );
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

      // Act
      const response = await GET(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(prisma.aiConversation.findMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Pagination
  // ---------------------------------------------------------------------------

  describe('Pagination', () => {
    it('should apply skip/take based on the page and limit parameters', async () => {
      // Arrange
      const request = createMockRequest({ page: '2', limit: '5' });

      // Act
      await GET(request);

      // Assert: skip = (2-1) * 5 = 5, take = 5
      expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 })
      );
    });

    it('should order conversations by updatedAt descending', async () => {
      // Arrange
      const request = createMockRequest();

      // Act
      await GET(request);

      // Assert
      expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { updatedAt: 'desc' } })
      );
    });
  });
});
