/**
 * Tests: Budget Alerts Route
 *
 * GET /api/v1/admin/orchestration/costs/alerts
 *
 * @see app/api/v1/admin/orchestration/costs/alerts/route.ts
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
  getBudgetAlerts: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import { getBudgetAlerts } from '@/lib/orchestration/llm/cost-reports';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/admin/orchestration/costs/alerts/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/costs/alerts', {
    method: 'GET',
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/costs/alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(getBudgetAlerts).mockResolvedValue([]);
  });

  // ── Auth ───────────────────────────────────────────────────────────────

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await GET(makeRequest());
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
    const response = await GET(makeRequest());
    expect(response.status).toBe(429);
  });

  // ── Happy path ────────────────────────────────────────────────────────

  it('returns alerts from getBudgetAlerts', async () => {
    const mockAlerts = [
      { agentId: 'a1', agentSlug: 'bot', utilisation: 0.85, severity: 'warning' },
      { agentId: 'a2', agentSlug: 'bot2', utilisation: 1.1, severity: 'critical' },
    ];
    vi.mocked(getBudgetAlerts).mockResolvedValue(mockAlerts as never);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.alerts).toHaveLength(2);
  });

  it('returns empty alerts array when no agents are over budget', async () => {
    vi.mocked(getBudgetAlerts).mockResolvedValue([]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.alerts).toEqual([]);
  });
});
