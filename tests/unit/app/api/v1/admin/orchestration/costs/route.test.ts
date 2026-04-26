/**
 * Tests: Cost Breakdown Route
 *
 * GET /api/v1/admin/orchestration/costs
 *
 * @see app/api/v1/admin/orchestration/costs/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

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

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@/lib/orchestration/llm/cost-reports', () => ({
  getCostBreakdown: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import { getCostBreakdown } from '@/lib/orchestration/llm/cost-reports';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/admin/orchestration/costs/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/costs');
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  return new NextRequest(url, { method: 'GET' });
}

const validParams = {
  dateFrom: '2026-04-01',
  dateTo: '2026-04-25',
  groupBy: 'day',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/costs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(getCostBreakdown).mockResolvedValue({
      groupBy: 'day',
      rows: [],
      totals: { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 },
    } as never);
  });

  // ── Auth ───────────────────────────────────────────────────────────────

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeRequest(validParams));
    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await GET(makeRequest(validParams));
    expect(response.status).toBe(403);
  });

  // ── Rate limiting ─────────────────────────────────────────────────────

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);
    const response = await GET(makeRequest(validParams));
    expect(response.status).toBe(429);
  });

  // ── Happy path ────────────────────────────────────────────────────────

  it('returns breakdown data for valid query params', async () => {
    const mockBreakdown = {
      groupBy: 'day',
      rows: [{ date: '2026-04-01', totalCostUsd: 12.5 }],
      totals: { totalCostUsd: 12.5, totalInputTokens: 1000, totalOutputTokens: 500 },
    };
    vi.mocked(getCostBreakdown).mockResolvedValue(mockBreakdown as never);

    const response = await GET(makeRequest(validParams));
    const body = await response.json();

    expect(response.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.groupBy).toBe('day');
    expect(body.data.rows).toHaveLength(1);
  });

  it('passes agentId filter to getCostBreakdown when provided', async () => {
    await GET(makeRequest({ ...validParams, agentId: 'cmjbv4i3x00003wsloputgwul' }));

    expect(getCostBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'cmjbv4i3x00003wsloputgwul' })
    );
  });

  it('omits agentId from getCostBreakdown params when not provided', async () => {
    await GET(makeRequest(validParams));

    const call = vi.mocked(getCostBreakdown).mock.calls[0][0];
    expect(call).not.toHaveProperty('agentId');
  });
});
