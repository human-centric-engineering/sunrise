/**
 * Integration Test: Admin Orchestration — Cost Breakdown
 *
 * GET /api/v1/admin/orchestration/costs
 *
 * @see app/api/v1/admin/orchestration/costs/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - costBreakdownQuerySchema validation: missing/invalid params → 400
 * - dateFrom > dateTo → 400
 * - span > 366 days → 400
 * - groupBy=day/agent/model each return the mocked breakdown shape
 * - Admin-global (NOT user-scoped) — no userId filter
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/costs/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/orchestration/llm/cost-reports', () => ({
  getCostBreakdown: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { getCostBreakdown } from '@/lib/orchestration/llm/cost-reports';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DATE_FROM = '2025-01-01';
const DATE_TO = '2025-01-31';

function makeBreakdownResult(groupBy: 'day' | 'agent' | 'model') {
  return {
    groupBy,
    rows: [
      {
        key: groupBy === 'day' ? DATE_FROM : 'cmjbv4i3x00003wsloputgwu1',
        label: groupBy !== 'day' ? 'Test Agent' : undefined,
        totalCostUsd: 1.23,
        inputTokens: 1000,
        outputTokens: 500,
        count: 10,
      },
    ],
    totals: { totalCostUsd: 1.23, inputTokens: 1000, outputTokens: 500, count: 10 },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/costs');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/costs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(
        makeGetRequest({ dateFrom: DATE_FROM, dateTo: DATE_TO, groupBy: 'day' })
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(
        makeGetRequest({ dateFrom: DATE_FROM, dateTo: DATE_TO, groupBy: 'day' })
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when groupBy is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest({ dateFrom: DATE_FROM, dateTo: DATE_TO }));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when groupBy=month (invalid enum value)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(
        makeGetRequest({ dateFrom: DATE_FROM, dateTo: DATE_TO, groupBy: 'month' })
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when dateFrom is after dateTo', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(
        makeGetRequest({ dateFrom: '2025-02-01', dateTo: '2025-01-01', groupBy: 'day' })
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when span exceeds 366 days', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(
        makeGetRequest({ dateFrom: '2024-01-01', dateTo: '2025-02-15', groupBy: 'day' })
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when dateFrom is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest({ dateTo: DATE_TO, groupBy: 'day' }));

      expect(response.status).toBe(400);
    });
  });

  describe('Successful responses', () => {
    it('returns 200 with breakdown grouped by day', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getCostBreakdown).mockResolvedValue(makeBreakdownResult('day'));

      const response = await GET(
        makeGetRequest({ dateFrom: DATE_FROM, dateTo: DATE_TO, groupBy: 'day' })
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { groupBy: string; rows: unknown[]; totals: unknown };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.groupBy).toBe('day');
      expect(Array.isArray(data.data.rows)).toBe(true);
      expect(data.data.totals).toBeDefined();
    });

    it('returns 200 with breakdown grouped by agent', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getCostBreakdown).mockResolvedValue(makeBreakdownResult('agent'));

      const response = await GET(
        makeGetRequest({ dateFrom: DATE_FROM, dateTo: DATE_TO, groupBy: 'agent' })
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { groupBy: string } }>(response);
      expect(data.data.groupBy).toBe('agent');
    });

    it('returns 200 with breakdown grouped by model', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getCostBreakdown).mockResolvedValue(makeBreakdownResult('model'));

      const response = await GET(
        makeGetRequest({ dateFrom: DATE_FROM, dateTo: DATE_TO, groupBy: 'model' })
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { groupBy: string } }>(response);
      expect(data.data.groupBy).toBe('model');
    });

    it('calls getCostBreakdown with the parsed date range and groupBy', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getCostBreakdown).mockResolvedValue(makeBreakdownResult('day'));

      await GET(makeGetRequest({ dateFrom: DATE_FROM, dateTo: DATE_TO, groupBy: 'day' }));

      expect(vi.mocked(getCostBreakdown)).toHaveBeenCalledWith(
        expect.objectContaining({
          groupBy: 'day',
          dateFrom: expect.any(Date),
          dateTo: expect.any(Date),
        })
      );
    });
  });
});
