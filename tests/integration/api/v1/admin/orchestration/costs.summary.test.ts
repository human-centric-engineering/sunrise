/**
 * Integration Test: Admin Orchestration — Cost Summary
 *
 * GET /api/v1/admin/orchestration/costs/summary
 *
 * @see app/api/v1/admin/orchestration/costs/summary/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Happy path: returns totals, byAgent, byModel, trend from getCostSummary
 * - Admin-global (NOT user-scoped)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/costs/summary/route';
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
  getCostSummary: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { getCostSummary } from '@/lib/orchestration/llm/cost-reports';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCostSummary() {
  return {
    totals: { today: 0.5, week: 3.2, month: 12.8 },
    byAgent: [
      {
        agentId: 'cmjbv4i3x00003wsloputgwu1',
        name: 'Test Agent',
        slug: 'test-agent',
        monthSpend: 12.8,
        monthlyBudgetUsd: 100,
        utilisation: 0.128,
      },
    ],
    byModel: [{ model: 'claude-sonnet-4-6', monthSpend: 12.8 }],
    trend: [{ date: '2025-01-01', totalCostUsd: 0.4 }],
    localSavings: null,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/costs/summary');
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/costs/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Successful response', () => {
    it('returns 200 with full CostSummary shape', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getCostSummary).mockResolvedValue(makeCostSummary());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: {
          totals: { today: number; week: number; month: number };
          byAgent: unknown[];
          byModel: unknown[];
          trend: unknown[];
        };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.totals).toMatchObject({ today: 0.5, week: 3.2, month: 12.8 });
      expect(Array.isArray(data.data.byAgent)).toBe(true);
      expect(Array.isArray(data.data.byModel)).toBe(true);
      expect(Array.isArray(data.data.trend)).toBe(true);
    });

    it('calls getCostSummary once with no arguments', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getCostSummary).mockResolvedValue(makeCostSummary());

      await GET(makeGetRequest());

      expect(vi.mocked(getCostSummary)).toHaveBeenCalledOnce();
    });
  });
});
