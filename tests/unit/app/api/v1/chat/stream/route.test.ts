/**
 * Unit Tests: POST /api/v1/chat/stream
 *
 * Tests the consumer-facing SSE chat endpoint. Only agents with
 * visibility='public' and isActive=true are accessible. Uses two rate
 * limiters: one per IP and one per user.
 *
 * Test Coverage:
 * - Happy path: valid request with public agent → calls streamChat → SSE response
 * - Agent not found: slug doesn't match any public+active agent → 404
 * - Agent is internal: agent exists but visibility='internal' → 404
 * - Agent is inactive: agent exists but isActive=false → 404
 * - Rate limit exceeded (IP) → 429
 * - Rate limit exceeded (user) → 429
 * - Invalid body: missing required `message` field → 400 VALIDATION_ERROR
 * - Authentication: no session → 401 (delegated to withAuth)
 *
 * @see app/api/v1/chat/stream/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/v1/chat/stream/route';
import type { NextRequest } from 'next/server';

/**
 * Mock dependencies
 *
 * getRouteLogger is mocked globally in tests/setup.ts — no local mock needed.
 * next/headers is mocked globally in tests/setup.ts.
 */

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findFirst: vi.fn(),
    },
    aiAgentInviteToken: {
      findFirst: vi.fn(),
      update: vi.fn(),
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
  consumerChatLimiter: {
    check: vi.fn(),
  },
  agentChatLimiter: {
    check: vi.fn(() => ({ success: true })),
    reset: vi.fn(),
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

// Mock streamChat
vi.mock('@/lib/orchestration/chat', () => ({
  streamChat: vi.fn(),
}));

// Mock SSE response helper
vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn(() => new Response('data: test\n\n', { status: 200 })),
}));

// Mock logging context
vi.mock('@/lib/logging/context', () => ({
  getRequestId: vi.fn(() => Promise.resolve('req-test-001')),
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';
import {
  apiLimiter,
  consumerChatLimiter,
  agentChatLimiter,
  createRateLimitResponse,
} from '@/lib/security/rate-limit';
import { streamChat } from '@/lib/orchestration/chat';
import { sseResponse } from '@/lib/api/sse';

/**
 * Response type interfaces
 */
interface ErrorResponseBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

/**
 * Helper: create a mock NextRequest with a JSON body
 */
function createMockRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/chat/stream');
  return {
    json: async () => body,
    headers: new Headers(headers),
    url: url.toString(),
    nextUrl: { searchParams: url.searchParams },
    signal: new AbortController().signal,
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
 * Helper: build a rate-limit result
 */
function makeRateLimitResult(success: boolean, remaining = 10) {
  return {
    success,
    limit: 20,
    remaining,
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
 * A public, active agent record
 */
const mockPublicAgent = {
  id: 'agent-001',
  slug: 'helper-bot',
  visibility: 'public',
  rateLimitRpm: null,
};

/**
 * Valid request payload
 */
const validPayload = {
  message: 'Hello, how can you help me?',
  agentSlug: 'helper-bot',
};

// =============================================================================
// Test Suite
// =============================================================================

describe('POST /api/v1/chat/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated session
    vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession() as never);

    // Default: rate limits allow the request
    vi.mocked(apiLimiter.check).mockReturnValue(makeRateLimitResult(true));
    vi.mocked(consumerChatLimiter.check).mockReturnValue(makeRateLimitResult(true));

    // Default: public agent found
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(mockPublicAgent as never);

    // Default: streamChat returns an async iterable with a valid ChatEvent shape
    vi.mocked(streamChat).mockReturnValue(
      (async function* () {
        yield { type: 'content' as const, delta: 'Hello!' };
      })()
    );
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------

  describe('Happy path', () => {
    it('should call streamChat and return SSE response for a valid public agent request', async () => {
      // Arrange
      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);

      // Assert: SSE response returned
      expect(response.status).toBe(200);
      expect(sseResponse).toHaveBeenCalledOnce();

      // Assert: agent lookup used the correct filters
      expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith({
        where: {
          slug: 'helper-bot',
          isActive: true,
          visibility: { in: ['public', 'invite_only'] },
        },
        select: { id: true, slug: true, visibility: true, rateLimitRpm: true },
      });

      // Assert: streamChat called with correct args
      expect(streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          message: validPayload.message,
          agentSlug: validPayload.agentSlug,
          userId: 'user_test123',
        })
      );
    });

    it('should pass conversationId to streamChat when provided', async () => {
      // Arrange
      const payloadWithConversation = {
        ...validPayload,
        conversationId: 'clh3z8q0v0000356i0n2v3g8k',
      };
      const request = createMockRequest(payloadWithConversation);

      // Act
      await POST(request);

      // Assert
      expect(streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'clh3z8q0v0000356i0n2v3g8k',
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Agent visibility / existence checks
  // ---------------------------------------------------------------------------

  describe('Agent not found', () => {
    it('should return 404 when no agent matches the slug with public+active filters', async () => {
      // Arrange: no matching agent
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);
      const request = createMockRequest({ ...validPayload, agentSlug: 'unknown-bot' });

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(streamChat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 404 when agent has visibility="internal"', async () => {
      // Arrange: query returns null because visibility filter excludes internal agents
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);
      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('should return 404 when agent is inactive (isActive=false)', async () => {
      // Arrange: query returns null because isActive filter excludes inactive agents
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);
      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(streamChat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Rate limiting
  // ---------------------------------------------------------------------------

  describe('Rate limiting', () => {
    it('should return 429 when the IP rate limit is exceeded', async () => {
      // Arrange
      vi.mocked(apiLimiter.check).mockReturnValue(makeRateLimitResult(false, 0));
      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(429);
      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(streamChat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 429 when the per-user chat rate limit is exceeded', async () => {
      // Arrange: IP passes but user limit fails
      vi.mocked(apiLimiter.check).mockReturnValue(makeRateLimitResult(true));
      vi.mocked(consumerChatLimiter.check).mockReturnValue(makeRateLimitResult(false, 0));
      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(429);
      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(streamChat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should check the IP limiter before the user limiter', async () => {
      // Arrange: both would fail, but IP is checked first
      vi.mocked(apiLimiter.check).mockReturnValue(makeRateLimitResult(false, 0));
      vi.mocked(consumerChatLimiter.check).mockReturnValue(makeRateLimitResult(false, 0));
      const request = createMockRequest(validPayload);

      // Act
      await POST(request);

      // Assert: IP limiter called; user limiter never reached
      expect(apiLimiter.check).toHaveBeenCalledOnce();
      expect(consumerChatLimiter.check).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Validation errors
  // ---------------------------------------------------------------------------

  describe('Validation errors', () => {
    it('should return 400 when message is missing', async () => {
      // Arrange
      const { message: _message, ...withoutMessage } = validPayload;
      const request = createMockRequest(withoutMessage);

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(streamChat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 400 when agentSlug is missing', async () => {
      // Arrange
      const { agentSlug: _agentSlug, ...withoutSlug } = validPayload;
      const request = createMockRequest(withoutSlug);

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when message is empty string', async () => {
      // Arrange
      const request = createMockRequest({ ...validPayload, message: '' });

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Authentication (delegated to withAuth)
  // ---------------------------------------------------------------------------

  describe('Authentication', () => {
    it('should return 401 when there is no active session', async () => {
      // Arrange: no session
      vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(streamChat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Per-agent rate limiting
  // ---------------------------------------------------------------------------

  describe('Per-agent rate limiting', () => {
    it('should return 429 when the per-agent rate limit is exceeded', async () => {
      // Arrange: IP and user limits pass but agent-level limit fails
      vi.mocked(agentChatLimiter.check).mockReturnValue(makeRateLimitResult(false, 0));
      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(429);
      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(streamChat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should pass agent rateLimitRpm to the per-agent limiter', async () => {
      // Arrange: agent has a custom RPM limit
      const agentWithRateLimit = { ...mockPublicAgent, rateLimitRpm: 5 };
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(agentWithRateLimit as never);
      vi.mocked(agentChatLimiter.check).mockReturnValue(makeRateLimitResult(true));
      const request = createMockRequest(validPayload);

      // Act
      await POST(request);

      // Assert: agent limiter called with agent:user key and custom RPM
      expect(agentChatLimiter.check).toHaveBeenCalledWith(
        `${agentWithRateLimit.id}:user_test123`,
        5
      );
      expect(streamChat).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Invite-only agent access control
  // ---------------------------------------------------------------------------

  describe('Invite-only agent', () => {
    const mockInviteOnlyAgent = {
      id: 'agent-002',
      slug: 'private-bot',
      visibility: 'invite_only',
      rateLimitRpm: null,
    };

    beforeEach(() => {
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(mockInviteOnlyAgent as never);
    });

    it('should return 403 when invite token is missing for invite_only agent', async () => {
      // Arrange: no inviteToken in payload
      const request = createMockRequest({ ...validPayload, agentSlug: 'private-bot' });

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(streamChat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 403 when invite token is invalid or revoked', async () => {
      // Arrange: token not found in DB
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(null);
      const request = createMockRequest({
        ...validPayload,
        agentSlug: 'private-bot',
        inviteToken: 'bad-token',
      });

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(streamChat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should return 403 when invite token has expired', async () => {
      // Arrange: token exists but expiresAt is in the past
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
        id: 'tok-1',
        agentId: 'agent-002',
        token: 'expired-token',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
        maxUses: null,
        useCount: 0,
      } as never);
      const request = createMockRequest({
        ...validPayload,
        agentSlug: 'private-bot',
        inviteToken: 'expired-token',
      });

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('should return 403 when invite token has reached its usage limit', async () => {
      // Arrange: token has maxUses=5 and useCount=5
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
        id: 'tok-2',
        agentId: 'agent-002',
        token: 'maxed-token',
        revokedAt: null,
        expiresAt: null,
        maxUses: 5,
        useCount: 5,
      } as never);
      const request = createMockRequest({
        ...validPayload,
        agentSlug: 'private-bot',
        inviteToken: 'maxed-token',
      });

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('should allow access and increment use count with a valid invite token', async () => {
      // Arrange: valid token, not expired, not maxed
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
        id: 'tok-3',
        agentId: 'agent-002',
        token: 'valid-token',
        revokedAt: null,
        expiresAt: null,
        maxUses: 10,
        useCount: 3,
      } as never);
      vi.mocked(prisma.aiAgentInviteToken.update).mockResolvedValue({} as never);
      const request = createMockRequest({
        ...validPayload,
        agentSlug: 'private-bot',
        inviteToken: 'valid-token',
      });

      // Act
      const response = await POST(request);

      // Assert: stream started and use count incremented
      expect(response.status).toBe(200);
      expect(sseResponse).toHaveBeenCalledOnce();
      expect(prisma.aiAgentInviteToken.update).toHaveBeenCalledWith({
        where: { id: 'tok-3' },
        data: { useCount: { increment: 1 } },
      });
    });

    it('should allow access with unlimited token (maxUses null)', async () => {
      // Arrange: valid token with no use cap
      vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
        id: 'tok-4',
        agentId: 'agent-002',
        token: 'unlimited-token',
        revokedAt: null,
        expiresAt: null,
        maxUses: null,
        useCount: 9999,
      } as never);
      vi.mocked(prisma.aiAgentInviteToken.update).mockResolvedValue({} as never);
      const request = createMockRequest({
        ...validPayload,
        agentSlug: 'private-bot',
        inviteToken: 'unlimited-token',
      });

      // Act
      const response = await POST(request);

      // Assert: maxUses=null means no cap — stream proceeds
      expect(response.status).toBe(200);
      expect(sseResponse).toHaveBeenCalledOnce();
    });
  });
});
