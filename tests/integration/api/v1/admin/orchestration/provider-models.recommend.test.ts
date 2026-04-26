/**
 * Integration Test: Admin Orchestration Provider Model Recommendations
 *
 * GET /api/v1/admin/orchestration/provider-models/recommend?intent=thinking
 *
 * Key assertions:
 *   - Returns scored recommendations for a valid intent
 *   - Supports the embedding intent
 *   - Validates the intent query parameter
 *   - Respects the limit parameter
 *   - Auth enforced
 *
 * @see app/api/v1/admin/orchestration/provider-models/recommend/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/provider-models/recommend/route';
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

vi.mock('@/lib/orchestration/llm/provider-selector', () => ({
  recommendModels: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { recommendModels } from '@/lib/orchestration/llm/provider-selector';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeRecommendation(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'anthropic-claude-opus-4',
    providerSlug: 'anthropic',
    modelId: 'claude-opus-4',
    name: 'Claude Opus 4',
    tierRole: 'thinking',
    bestRole: 'Long-context reasoning',
    score: 95,
    reason: 'Tier match + very_high reasoning depth',
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/provider-models/recommend');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/provider-models/recommend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const response = await GET(makeGetRequest({ intent: 'thinking' }));
      expect(response.status).toBe(401);
    });

    it('returns 403 when non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const response = await GET(makeGetRequest({ intent: 'thinking' }));
      expect(response.status).toBe(403);
    });
  });

  describe('Validation', () => {
    it('returns 400 when intent is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await GET(makeGetRequest());
      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid intent value', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await GET(makeGetRequest({ intent: 'invalid_intent' }));
      expect(response.status).toBe(400);
    });
  });

  describe('Recommendations', () => {
    it('returns recommendations for thinking intent', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(recommendModels).mockResolvedValue([makeRecommendation()] as never);

      const response = await GET(makeGetRequest({ intent: 'thinking' }));
      expect(response.status).toBe(200);

      const data = await parseJson<{
        success: boolean;
        data: { intent: string; recommendations: Array<{ slug: string; score: number }> };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.intent).toBe('thinking');
      expect(data.data.recommendations).toHaveLength(1);
      expect(data.data.recommendations[0].slug).toBe('anthropic-claude-opus-4');
    });

    it('supports the embedding intent', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(recommendModels).mockResolvedValue([
        makeRecommendation({
          slug: 'openai-text-embedding-3-small',
          providerSlug: 'openai',
          modelId: 'text-embedding-3-small',
          tierRole: 'embedding',
          score: 90,
        }),
      ] as never);

      const response = await GET(makeGetRequest({ intent: 'embedding' }));
      expect(response.status).toBe(200);

      const data = await parseJson<{
        data: { intent: string; recommendations: Array<{ tierRole: string }> };
      }>(response);
      expect(data.data.intent).toBe('embedding');
      expect(data.data.recommendations[0].tierRole).toBe('embedding');
    });

    it('passes limit parameter to recommendModels', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(recommendModels).mockResolvedValue([] as never);

      await GET(makeGetRequest({ intent: 'doing', limit: '3' }));

      expect(recommendModels).toHaveBeenCalledWith('doing', { limit: 3 });
    });

    it('includes heuristic descriptions in the response', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(recommendModels).mockResolvedValue([] as never);

      const response = await GET(makeGetRequest({ intent: 'thinking' }));
      const data = await parseJson<{
        data: { heuristic: Record<string, string> };
      }>(response);

      expect(data.data.heuristic).toHaveProperty('thinking');
      expect(data.data.heuristic).toHaveProperty('embedding');
      expect(data.data.heuristic).toHaveProperty('doing');
      expect(data.data.heuristic).toHaveProperty('fast_looping');
      expect(data.data.heuristic).toHaveProperty('high_reliability');
      expect(data.data.heuristic).toHaveProperty('private');
    });
  });
});
