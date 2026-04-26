/**
 * Unit Test: GET /api/v1/admin/orchestration/agents/:id/capabilities/usage
 *
 * Tests the capability rate-limit usage endpoint that returns the number of
 * capability executions per slug in the last 60 seconds for an agent.
 *
 * Test Coverage:
 * - Rejects unauthenticated requests (401)
 * - Rejects non-admin users (403)
 * - Validates agent ID (invalid CUID → 400)
 * - Returns empty usage map when no tool_call logs exist
 * - Returns populated usage map from AiCostLog query results
 * - Filters out rows with null/empty slug gracefully
 * - Uses parameterized query (prisma.$queryRaw called with agentId)
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/capabilities/usage/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/agents/[id]/capabilities/usage/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/capabilities/usage`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/agents/:id/capabilities/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── Authentication & Authorization ─────────────────────────────────────────

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await GET(makeGetRequest(), makeParams(AGENT_ID));

      // Assert
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as a non-admin user', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await GET(makeGetRequest(), makeParams(AGENT_ID));

      // Assert
      expect(response.status).toBe(403);
    });
  });

  // ── Input validation ───────────────────────────────────────────────────────

  describe('Input validation', () => {
    it('returns 4xx for an invalid (non-CUID) agent ID', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await GET(makeGetRequest(), makeParams(INVALID_ID));

      // Assert
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });
  });

  // ── Empty usage ────────────────────────────────────────────────────────────

  describe('Empty usage', () => {
    it('returns an empty usage object when no tool_call logs exist', async () => {
      // Arrange: query returns empty array
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.$queryRaw).mockResolvedValue([]);

      // Act
      const response = await GET(makeGetRequest(), makeParams(AGENT_ID));

      // Assert
      expect(response.status).toBe(200);
      const body = await parseJson<{ success: boolean; data: { usage: Record<string, number> } }>(
        response
      );
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(body.success).toBe(true);
      expect(body.data.usage).toEqual({});
    });
  });

  // ── Populated usage ────────────────────────────────────────────────────────

  describe('Populated usage', () => {
    it('returns usage counts keyed by capability slug', async () => {
      // Arrange: query returns two slug rows
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        { slug: 'web-search', count: 12 },
        { slug: 'calculator', count: 3 },
      ]);

      // Act
      const response = await GET(makeGetRequest(), makeParams(AGENT_ID));

      // Assert
      expect(response.status).toBe(200);
      const body = await parseJson<{ data: { usage: Record<string, number> } }>(response);
      expect(body.data.usage).toEqual({
        'web-search': 12,
        calculator: 3,
      });
    });

    it('returns a single-entry usage map when only one capability has been called', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ slug: 'code-runner', count: 1 }]);

      // Act
      const response = await GET(makeGetRequest(), makeParams(AGENT_ID));

      // Assert
      const body = await parseJson<{ data: { usage: Record<string, number> } }>(response);
      expect(body.data.usage).toEqual({ 'code-runner': 1 });
    });

    it('filters out rows where slug is null or empty', async () => {
      // Arrange: one row has a null slug (should be ignored)
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        { slug: 'web-search', count: 5 },
        { slug: null, count: 2 },
        { slug: '', count: 1 },
      ]);

      // Act
      const response = await GET(makeGetRequest(), makeParams(AGENT_ID));

      // Assert: only the valid slug appears
      const body = await parseJson<{ data: { usage: Record<string, number> } }>(response);
      expect(body.data.usage).toEqual({ 'web-search': 5 });
      expect('').not.toBeOneOf(Object.keys(body.data.usage));
    });
  });

  // ── Parameterized query ────────────────────────────────────────────────────

  describe('Parameterized query', () => {
    it('calls prisma.$queryRaw with the agent ID as a parameter', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.$queryRaw).mockResolvedValue([]);

      // Act
      await GET(makeGetRequest(), makeParams(AGENT_ID));

      // Assert: $queryRaw was called (not raw string concatenation)
      expect(prisma.$queryRaw).toHaveBeenCalledOnce();

      // The call must include the agent ID as a parameter value (not baked
      // into the SQL string). Prisma tagged template calls pass the values
      // array separately from the SQL template strings.
      const callArgs = vi.mocked(prisma.$queryRaw).mock.calls[0];

      // callArgs[0] is the TemplateStringsArray; values are the rest of the args.
      // Verify the agent ID is a value parameter, not inside the SQL string.
      const paramValues = callArgs.slice(1);
      expect(paramValues).toContain(AGENT_ID);
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    it('returns 429 when the rate limit is exceeded', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      // Act
      const response = await GET(makeGetRequest(), makeParams(AGENT_ID));

      // Assert
      expect(response.status).toBe(429);
    });
  });
});
