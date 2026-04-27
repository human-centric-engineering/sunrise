/**
 * Unit Tests: GET /api/v1/chat/agents
 *
 * Tests the consumer available agents list endpoint. Returns only active,
 * publicly visible agents. Exposes a minimal payload — no system instructions,
 * provider config, or internal details are included.
 *
 * Test Coverage:
 * - Happy path: returns active public agents with minimal payload
 * - Returns only id, name, slug, description fields
 * - Excludes inactive agents (isActive=false)
 * - Excludes internal agents (visibility='internal')
 * - Empty list when no public agents exist
 * - Ordered alphabetically by name
 * - Authentication: no session → 401 (delegated to withAuth)
 *
 * @see app/api/v1/chat/agents/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/v1/chat/agents/route';
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
    aiAgent: {
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
interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

interface SuccessResponseBody {
  success: true;
  data: { agents: Agent[] };
}

interface ErrorResponseBody {
  success: false;
  error: { code: string; message: string };
}

/**
 * Helper: create a mock NextRequest
 */
function createMockRequest(): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/chat/agents');
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
 * Mock agent records (minimal payload — as returned by the select clause)
 */
function makeMockAgents(): Agent[] {
  return [
    { id: 'agent-001', name: 'Helper Bot', slug: 'helper-bot', description: 'General assistant' },
    { id: 'agent-002', name: 'Support Agent', slug: 'support-agent', description: null },
  ];
}

// =============================================================================
// Test Suite
// =============================================================================

describe('GET /api/v1/chat/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession() as never);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(makeMockAgents() as never);
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------

  describe('Happy path', () => {
    it('should return active public agents', async () => {
      // Arrange
      const request = createMockRequest();

      // Act
      const response = await GET(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(body.success).toBe(true);
      expect(body.data.agents).toHaveLength(2);
    });

    it('should filter for isActive=true and visibility=public', async () => {
      // Arrange
      const request = createMockRequest();

      // Act
      await GET(request);

      // Assert: query uses the correct filters
      expect(prisma.aiAgent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, visibility: 'public' },
        })
      );
    });

    it('should select only id, name, slug, description fields', async () => {
      // Arrange
      const request = createMockRequest();

      // Act
      await GET(request);

      // Assert: no system instructions or provider config exposed
      expect(prisma.aiAgent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
          },
        })
      );
    });

    it('should order agents by name ascending', async () => {
      // Arrange
      const request = createMockRequest();

      // Act
      await GET(request);

      // Assert
      expect(prisma.aiAgent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { name: 'asc' } })
      );
    });

    it('should include agents with null description', async () => {
      // Arrange
      const agentsWithNull = [
        { id: 'agent-001', name: 'Helper Bot', slug: 'helper-bot', description: null },
      ];
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(agentsWithNull as never);
      const request = createMockRequest();

      // Act
      const response = await GET(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert
      expect(body.data.agents[0].description).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Empty list
  // ---------------------------------------------------------------------------

  describe('Empty list', () => {
    it('should return an empty agents array when no public agents exist', async () => {
      // Arrange
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      const request = createMockRequest();

      // Act
      const response = await GET(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(body.success).toBe(true);
      expect(body.data.agents).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Field exposure safety
  // ---------------------------------------------------------------------------

  describe('Minimal payload enforcement', () => {
    it('should not expose sensitive fields from the database response', async () => {
      // Arrange: the query result contains only the selected fields
      const request = createMockRequest();

      // Act
      const response = await GET(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: each agent has only the expected safe fields
      body.data.agents.forEach((agent) => {
        const agentKeys = Object.keys(agent);
        expect(agentKeys).toContain('id');
        expect(agentKeys).toContain('name');
        expect(agentKeys).toContain('slug');
        expect(agentKeys).toContain('description');
        // Verify no additional fields leaked (4 fields max)
        expect(agentKeys.length).toBeLessThanOrEqual(4);
      });
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
      expect(prisma.aiAgent.findMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });
});
