/**
 * Integration Test: Aggregated model catalogue
 *
 * GET /api/v1/admin/orchestration/models
 * GET /api/v1/admin/orchestration/models?refresh=true
 *
 * Key behaviours:
 *   - Default path returns models without calling refreshFromOpenRouter
 *   - ?refresh=true calls refreshFromOpenRouter({ force: true })
 *   - ?refresh=true response includes refreshed: true
 *   - ?refresh=true is rate-limited (adminLimiter.check)
 *
 * @see app/api/v1/admin/orchestration/models/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/models/route';
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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getAvailableModels: vi.fn(() => []),
  getRegistryFetchedAt: vi.fn(() => 0),
  refreshFromOpenRouter: vi.fn(() => Promise.resolve()),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import { getAvailableModels, refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/models');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
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

  describe('Default path (no refresh)', () => {
    it('returns models list with refreshed: false', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getAvailableModels).mockReturnValue([
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' } as never,
      ]);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { models: unknown[]; refreshed: boolean };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.refreshed).toBe(false);
      expect(data.data.models).toHaveLength(1);
    });

    it('does NOT call refreshFromOpenRouter on the default path', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getAvailableModels).mockReturnValue([]);

      await GET(makeGetRequest());

      expect(vi.mocked(refreshFromOpenRouter)).not.toHaveBeenCalled();
    });

    it('does NOT call adminLimiter.check on the default path', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getAvailableModels).mockReturnValue([]);

      await GET(makeGetRequest());

      expect(vi.mocked(adminLimiter.check)).not.toHaveBeenCalled();
    });
  });

  describe('Refresh path (?refresh=true)', () => {
    it('calls refreshFromOpenRouter with { force: true }', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getAvailableModels).mockReturnValue([]);

      await GET(makeGetRequest({ refresh: 'true' }));

      expect(vi.mocked(refreshFromOpenRouter)).toHaveBeenCalledWith({ force: true });
    });

    it('returns refreshed: true in the response', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getAvailableModels).mockReturnValue([]);

      const response = await GET(makeGetRequest({ refresh: 'true' }));

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: { refreshed: boolean } }>(response);
      expect(data.data.refreshed).toBe(true);
    });

    it('is rate-limited on the refresh path', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await GET(makeGetRequest({ refresh: 'true' }));

      expect(response.status).toBe(429);
      expect(vi.mocked(refreshFromOpenRouter)).not.toHaveBeenCalled();
    });

    it('calls adminLimiter.check only on the refresh path', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getAvailableModels).mockReturnValue([]);

      await GET(makeGetRequest({ refresh: 'true' }));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });
});
