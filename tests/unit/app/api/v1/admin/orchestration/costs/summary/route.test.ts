/**
 * Unit Tests: Cost Summary Endpoint
 *
 * GET /api/v1/admin/orchestration/costs/summary
 *
 * Test Coverage:
 * - Happy path: returns cost summary with ETag header
 * - ETag conditional GET: 304 Not Modified when If-None-Match matches
 * - Authentication: 401 for unauthenticated requests
 * - Rate limiting: 429 when rate limit exceeded
 * - Summary structure: totals, byAgent, byModel fields present
 *
 * @see app/api/v1/admin/orchestration/costs/summary/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
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

vi.mock('@/lib/orchestration/llm/cost-reports', () => ({
  getCostSummary: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { GET } from '@/app/api/v1/admin/orchestration/costs/summary/route';
import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import { getCostSummary } from '@/lib/orchestration/llm/cost-reports';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { computeETag } from '@/lib/api/etag';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const mockSummary = {
  totals: { today: 1.23, week: 8.5, month: 32.0 },
  byAgent: [{ agentId: 'agent-1', agentName: 'Helper Bot', totalCost: 15.0, requestCount: 200 }],
  byModel: [
    { model: 'claude-sonnet-4-6', provider: 'anthropic', totalCost: 32.0, requestCount: 500 },
  ],
  dailyTrend: [
    { date: '2026-04-18', cost: 1.1 },
    { date: '2026-04-19', cost: 1.23 },
  ],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGetRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(headers),
    url: 'http://localhost:3000/api/v1/admin/orchestration/costs/summary',
  } as unknown as NextRequest;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/costs/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(getCostSummary).mockResolvedValue(mockSummary as never);
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  describe('Happy path', () => {
    it('returns cost summary with 200 status', async () => {
      // Act
      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(json.success).toBe(true);
      expect(json.data.totals.today).toBe(1.23);
      expect(json.data.totals.month).toBe(32.0);
    });

    it('returns byAgent and byModel breakdowns', async () => {
      // Act
      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      // Assert
      expect(json.data.byAgent).toHaveLength(1);
      expect(json.data.byAgent[0].agentName).toBe('Helper Bot');
      expect(json.data.byModel).toHaveLength(1);
      expect(json.data.byModel[0].model).toBe('claude-sonnet-4-6');
    });

    it('includes ETag header in response', async () => {
      // Act
      const res = await GET(makeGetRequest());

      // Assert: ETag header must be present
      expect(res.headers.get('ETag')).toBeTruthy();
      expect(res.headers.get('ETag')).toMatch(/^W\//);
    });

    it('calls getCostSummary exactly once', async () => {
      // Act
      await GET(makeGetRequest());

      // Assert
      expect(getCostSummary).toHaveBeenCalledOnce();
    });
  });

  // ── ETag conditional GET ─────────────────────────────────────────────────

  describe('ETag conditional GET', () => {
    it('returns 304 Not Modified when If-None-Match matches the current ETag', async () => {
      // Arrange: compute what the ETag will be
      const expectedEtag = computeETag(mockSummary);

      // Act: send request with matching If-None-Match header
      const res = await GET(makeGetRequest({ 'If-None-Match': expectedEtag }));

      // Assert: 304 returned, no body
      expect(res.status).toBe(304);
      expect(getCostSummary).toHaveBeenCalledOnce(); // summary still fetched to compute ETag
    });

    it('returns 200 when If-None-Match does not match', async () => {
      // Arrange: stale ETag from client
      const res = await GET(makeGetRequest({ 'If-None-Match': 'W/"stale-etag"' }));

      // Assert: full response returned
      expect(res.status).toBe(200);
    });

    it('returns 200 when no If-None-Match header is present', async () => {
      // Act: plain request with no conditional header
      const res = await GET(makeGetRequest());

      // Assert
      expect(res.status).toBe(200);
    });
  });

  // ── Authentication ───────────────────────────────────────────────────────

  describe('Authentication', () => {
    it('returns 401 for unauthenticated requests', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const res = await GET(makeGetRequest());

      // Assert
      expect(res.status).toBe(401);
      expect(getCostSummary).not.toHaveBeenCalled();
    });
  });

  // ── Rate limiting ────────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      // Arrange
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      // Act
      const res = await GET(makeGetRequest());

      // Assert
      expect(res.status).toBe(429);
      expect(getCostSummary).not.toHaveBeenCalled();
    });
  });
});
