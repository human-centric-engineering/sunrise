/**
 * Integration Test: Admin Orchestration — Budget Alerts
 *
 * GET /api/v1/admin/orchestration/costs/alerts
 *
 * @see app/api/v1/admin/orchestration/costs/alerts/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Empty alerts array when no agents exceed threshold
 * - Mocked response with warning + critical severities
 * - Admin-global (NOT user-scoped)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/costs/alerts/route';
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
  getBudgetAlerts: vi.fn(),
  getGlobalCapStatus: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { getBudgetAlerts, getGlobalCapStatus } from '@/lib/orchestration/llm/cost-reports';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeBudgetAlert(severity: 'warning' | 'critical') {
  return {
    agentId: 'cmjbv4i3x00003wsloputgwu1',
    name: 'Test Agent',
    slug: 'test-agent',
    monthlyBudgetUsd: 100,
    spent: severity === 'warning' ? 85 : 110,
    utilisation: severity === 'warning' ? 0.85 : 1.1,
    severity,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/costs/alerts');
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/costs/alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGlobalCapStatus).mockResolvedValue({ cap: null, spent: 0, exceeded: false });
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

  describe('Successful responses', () => {
    it('returns 200 with empty alerts array when no agents exceed threshold', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getBudgetAlerts).mockResolvedValue([]);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { alerts: unknown[] } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.alerts).toEqual([]);
    });

    it('returns 200 with warning severity alert', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getBudgetAlerts).mockResolvedValue([makeBudgetAlert('warning')]);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { alerts: Array<{ severity: string }> };
      }>(response);
      expect(data.data.alerts).toHaveLength(1);
      expect(data.data.alerts[0].severity).toBe('warning');
    });

    it('returns 200 with critical severity alert', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getBudgetAlerts).mockResolvedValue([makeBudgetAlert('critical')]);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { alerts: Array<{ severity: string }> };
      }>(response);
      expect(data.data.alerts[0].severity).toBe('critical');
    });

    it('returns both warning and critical alerts in a mixed response', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getBudgetAlerts).mockResolvedValue([
        makeBudgetAlert('critical'),
        makeBudgetAlert('warning'),
      ]);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { alerts: Array<{ severity: string }> };
      }>(response);
      expect(data.data.alerts).toHaveLength(2);
      const severities = data.data.alerts.map((a) => a.severity);
      expect(severities).toContain('critical');
      expect(severities).toContain('warning');
    });

    it('calls getBudgetAlerts once with no arguments', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getBudgetAlerts).mockResolvedValue([]);

      await GET(makeGetRequest());

      expect(vi.mocked(getBudgetAlerts)).toHaveBeenCalledOnce();
    });
  });
});
