/**
 * Unit Tests: GET /api/v1/chat/conversations/:id/messages
 *
 * Tests the conversation messages endpoint. Returns messages for a
 * conversation, scoped to the calling user and publicly visible agents.
 * Missing or unauthorized conversations return 404.
 *
 * Test Coverage:
 * - Happy path: returns messages for own conversation with public agent
 * - Returns only safe fields (id, role, content, createdAt)
 * - Not found: conversation doesn't exist → 404
 * - Not found: conversation owned by another user → 404
 * - Not found: conversation with internal/inactive agent → 404
 * - Invalid CUID format → 400 VALIDATION_ERROR
 * - Empty conversation: no messages → empty array
 * - Authentication: no session → 401 (delegated to withAuth)
 *
 * @see app/api/v1/chat/conversations/[id]/messages/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/v1/chat/conversations/[id]/messages/route';
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
    },
    aiMessage: {
      findMany: vi.fn(),
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
interface Message {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface SuccessResponseBody {
  success: true;
  data: { messages: Message[] };
}

interface ErrorResponseBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

/**
 * A valid CUID
 */
const VALID_CUID = 'clh3z8q0v0000356i0n2v3g8k';

/**
 * Helper: create a mock NextRequest
 */
function createMockRequest(): NextRequest {
  const url = new URL(`http://localhost:3000/api/v1/chat/conversations/${VALID_CUID}/messages`);
  return {
    json: async () => ({}),
    headers: new Headers(),
    url: url.toString(),
    nextUrl: { searchParams: url.searchParams },
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
 * Mock conversation record (minimal — no messages included here)
 */
function makeMockConversation() {
  return {
    id: VALID_CUID,
    userId: 'user_test123',
    agentId: 'agent-001',
    title: 'Test conversation',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T12:00:00.000Z'),
  };
}

/**
 * Mock message records (safe fields only, as returned by the select clause)
 */
function makeMockMessages() {
  return [
    {
      id: 'msg-001',
      role: 'user',
      content: 'Hello!',
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    },
    {
      id: 'msg-002',
      role: 'assistant',
      content: 'Hi! How can I help?',
      createdAt: new Date('2026-01-01T12:00:05.000Z'),
    },
  ];
}

// =============================================================================
// Test Suite
// =============================================================================

describe('GET /api/v1/chat/conversations/:id/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession() as never);
    vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeMockConversation() as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue(makeMockMessages() as never);
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------

  describe('Happy path', () => {
    it('should return messages for the conversation', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await GET(request, context);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(body.success).toBe(true);
      expect(body.data.messages).toHaveLength(2);
      expect(body.data.messages[0]).toMatchObject({ role: 'user', content: 'Hello!' });
      expect(body.data.messages[1]).toMatchObject({ role: 'assistant' });
    });

    it('should verify ownership before fetching messages', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      await GET(request, context);

      // Assert: findFirst uses userId + visibility filter before fetching messages
      expect(prisma.aiConversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: VALID_CUID,
            userId: 'user_test123',
            agent: { visibility: { in: ['public', 'invite_only'] }, isActive: true },
          },
        })
      );
      // test-review:accept no_arg_called — zero-arg side-effect trigger
      expect(prisma.aiMessage.findMany).toHaveBeenCalled();
    });

    it('should select only safe fields (id, role, content, createdAt)', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      await GET(request, context);

      // Assert: message query uses explicit select with only public-safe fields
      expect(prisma.aiMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: {
            id: true,
            role: true,
            content: true,
            createdAt: true,
          },
        })
      );
    });

    it('should order messages by createdAt ascending', async () => {
      // Arrange
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      await GET(request, context);

      // Assert
      expect(prisma.aiMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'asc' } })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Empty conversation
  // ---------------------------------------------------------------------------

  describe('Empty conversation', () => {
    it('should return an empty messages array when conversation has no messages', async () => {
      // Arrange
      vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([]);
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await GET(request, context);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(body.success).toBe(true);
      expect(body.data.messages).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Not found
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
      expect(prisma.aiMessage.findMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 404 when conversation belongs to another user', async () => {
      // Arrange: userId filter excludes other users → null
      vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(null);
      const request = createMockRequest();
      const context = createRouteContext(VALID_CUID);

      // Act
      const response = await GET(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert: 404 not 403 to avoid resource enumeration
      expect(response.status).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(prisma.aiMessage.findMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
  // 4. Validation errors
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
      expect(prisma.aiConversation.findFirst).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.aiMessage.findMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      const response = await GET(request, context);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(prisma.aiConversation.findFirst).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.aiMessage.findMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });
});
