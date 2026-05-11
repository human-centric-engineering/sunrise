/**
 * Integration Test: Model discovery
 *
 * GET /api/v1/admin/orchestration/discovery/models?providerSlug=...
 *
 * Key behaviours:
 *   - Two-tier fan-out: vendor SDK + OpenRouter, in parallel
 *   - Tolerates failure of either tier; both fail → 503
 *   - LEFT JOIN annotates inMatrix / matrixId
 *   - Heuristics produce sensible suggestions per candidate
 *   - 404 when providerSlug doesn't match an active config
 *
 * @see app/api/v1/admin/orchestration/discovery/models/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

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

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: {
      findUnique: vi.fn(),
    },
    aiProviderModel: {
      findMany: vi.fn(() => Promise.resolve([])),
    },
  },
}));

const mockListModels = vi.fn();

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(() => Promise.resolve({ listModels: mockListModels })),
  isApiKeyEnvVarSet: vi.fn(() => true),
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  refreshFromOpenRouter: vi.fn(() => Promise.resolve()),
  getModelsByProvider: vi.fn(() => []),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

import { GET } from '@/app/api/v1/admin/orchestration/discovery/models/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';
import { getModelsByProvider, refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmjbv4i3x00003wsloputgwul',
    name: 'OpenAI',
    slug: 'openai',
    providerType: 'openai-compatible',
    baseUrl: null,
    apiKeyEnvVar: 'OPENAI_API_KEY',
    isLocal: false,
    isActive: true,
    metadata: null,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeModelInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    provider: 'openai',
    tier: 'budget' as const,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6,
    maxContext: 128000,
    supportsTools: true,
    ...overrides,
  };
}

function makeRequest(providerSlug: string | null = 'openai'): NextRequest {
  const url = providerSlug
    ? `http://localhost:3000/api/v1/admin/orchestration/discovery/models?providerSlug=${providerSlug}`
    : `http://localhost:3000/api/v1/admin/orchestration/discovery/models`;
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/discovery/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
    vi.mocked(refreshFromOpenRouter).mockResolvedValue();
    vi.mocked(getModelsByProvider).mockReturnValue([]);
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const response = await GET(makeRequest());
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const response = await GET(makeRequest());
      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate-limited', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);
      const response = await GET(makeRequest());
      expect(response.status).toBe(429);
    });
  });

  describe('Validation', () => {
    it('returns 400 when providerSlug is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await GET(makeRequest(null));
      expect(response.status).toBe(400);
    });

    it('returns 404 when providerSlug does not match an active provider', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);
      const response = await GET(makeRequest('does-not-exist'));
      expect(response.status).toBe(404);
    });

    it('returns 404 when provider exists but is inactive', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(
        makeProvider({ isActive: false }) as never
      );
      const response = await GET(makeRequest('openai'));
      expect(response.status).toBe(404);
    });
  });

  describe('Two-tier discovery', () => {
    it('merges vendor + openrouter sources into a single candidate list', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }),
        makeModelInfo({ id: 'gpt-4o', name: 'GPT-4o' }),
      ]);
      vi.mocked(getModelsByProvider).mockReturnValue([
        // gpt-4o-mini exists in both → both source dots lit
        makeModelInfo({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }),
        // gpt-5 only in OpenRouter → openrouter dot only
        makeModelInfo({ id: 'gpt-5', name: 'GPT-5' }),
      ]);

      const response = await GET(makeRequest('openai'));
      expect(response.status).toBe(200);

      const data = await parseJson<{
        data: {
          candidates: Array<{ modelId: string; sources: { vendor: boolean; openrouter: boolean } }>;
        };
      }>(response);

      const byId = new Map(data.data.candidates.map((c) => [c.modelId, c.sources]));
      expect(byId.get('gpt-4o-mini')).toEqual({ vendor: true, openrouter: true });
      expect(byId.get('gpt-4o')).toEqual({ vendor: true, openrouter: false });
      expect(byId.get('gpt-5')).toEqual({ vendor: false, openrouter: true });
    });

    it('falls back to OpenRouter alone when vendor SDK fails', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      mockListModels.mockRejectedValue(new Error('vendor unreachable'));
      vi.mocked(getModelsByProvider).mockReturnValue([
        makeModelInfo({ id: 'gpt-5', name: 'GPT-5' }),
      ]);

      const response = await GET(makeRequest('openai'));
      expect(response.status).toBe(200);

      const data = await parseJson<{
        data: {
          candidates: Array<{ modelId: string; sources: { vendor: boolean; openrouter: boolean } }>;
        };
      }>(response);

      expect(data.data.candidates).toHaveLength(1);
      expect(data.data.candidates[0].sources).toEqual({ vendor: false, openrouter: true });
    });

    it('falls back to vendor alone when OpenRouter fails', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      mockListModels.mockResolvedValue([makeModelInfo({ id: 'gpt-4o-mini', name: 'GPT-4o mini' })]);
      vi.mocked(refreshFromOpenRouter).mockRejectedValue(new Error('OpenRouter down'));

      const response = await GET(makeRequest('openai'));
      expect(response.status).toBe(200);

      const data = await parseJson<{
        data: {
          candidates: Array<{ modelId: string; sources: { vendor: boolean; openrouter: boolean } }>;
        };
      }>(response);

      expect(data.data.candidates).toHaveLength(1);
      expect(data.data.candidates[0].sources).toEqual({ vendor: true, openrouter: false });
    });

    it('returns 503 when both tiers fail', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      mockListModels.mockRejectedValue(new Error('vendor down'));
      vi.mocked(refreshFromOpenRouter).mockRejectedValue(new Error('OpenRouter down'));

      const response = await GET(makeRequest('openai'));
      expect(response.status).toBe(503);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('PROVIDER_UNAVAILABLE');
    });

    it('skips vendor tier when API key env var is unset (non-local provider)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(false);
      vi.mocked(getModelsByProvider).mockReturnValue([makeModelInfo({ id: 'gpt-4o-mini' })]);

      const response = await GET(makeRequest('openai'));
      expect(response.status).toBe(200);
      // Vendor SDK should not have been invoked.
      expect(mockListModels).not.toHaveBeenCalled();
    });
  });

  describe('Matrix annotation', () => {
    it('marks candidates that already exist in the matrix', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        { id: 'matrix-1', modelId: 'gpt-4o-mini' },
      ] as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'gpt-4o-mini' }),
        makeModelInfo({ id: 'gpt-4o' }),
      ]);

      const response = await GET(makeRequest('openai'));
      const data = await parseJson<{
        data: {
          candidates: Array<{ modelId: string; inMatrix: boolean; matrixId: string | null }>;
        };
      }>(response);

      const byId = new Map(data.data.candidates.map((c) => [c.modelId, c]));
      expect(byId.get('gpt-4o-mini')).toMatchObject({ inMatrix: true, matrixId: 'matrix-1' });
      expect(byId.get('gpt-4o')).toMatchObject({ inMatrix: false, matrixId: null });
    });

    it('filters the matrix LEFT JOIN to active rows so deactivated entries appear as Discovered', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      mockListModels.mockResolvedValue([makeModelInfo({ id: 'gpt-4o-mini' })]);

      await GET(makeRequest('openai'));

      // The where clause must include `isActive: true` so soft-deleted
      // rows fall through and the operator can see them as Discovered
      // candidates (the bulk endpoint then surfaces them as
      // `already_in_matrix_inactive` when the operator tries to add).
      const findManyCall = vi.mocked(prisma.aiProviderModel.findMany).mock.calls[0]?.[0];
      expect(findManyCall?.where).toMatchObject({ providerSlug: 'openai', isActive: true });
    });
  });

  describe('Heuristic suggestions', () => {
    it('infers capability + derives tierRole / latency / costEfficiency', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({
          id: 'gpt-4o-mini',
          name: 'GPT-4o mini',
        }),
        makeModelInfo({
          id: 'text-embedding-3-small',
          name: 'text-embedding-3-small',
          inputCostPerMillion: 0.02,
          outputCostPerMillion: 0,
          maxContext: 8191,
          supportsTools: false,
        }),
      ]);

      const response = await GET(makeRequest('openai'));
      const data = await parseJson<{
        data: {
          candidates: Array<{
            modelId: string;
            inferredCapability: string;
            suggested: {
              tierRole: string;
              latency: string;
              costEfficiency: string;
              capabilities: string[];
              slug: string;
            };
          }>;
        };
      }>(response);

      const byId = new Map(data.data.candidates.map((c) => [c.modelId, c]));
      const mini = byId.get('gpt-4o-mini');
      expect(mini?.inferredCapability).toBe('chat');
      expect(mini?.suggested.tierRole).toBe('worker'); // cheap + fast
      expect(mini?.suggested.latency).toBe('fast');
      expect(mini?.suggested.costEfficiency).toBe('very_high'); // $0.15
      expect(mini?.suggested.capabilities).toEqual(['chat']);
      expect(mini?.suggested.slug).toBe('openai-gpt-4o-mini');

      const embed = byId.get('text-embedding-3-small');
      expect(embed?.inferredCapability).toBe('embedding');
      expect(embed?.suggested.tierRole).toBe('embedding');
      expect(embed?.suggested.capabilities).toEqual(['embedding']);
    });

    it('preserves inferred audio / reasoning / image / moderation capabilities', async () => {
      // Regression for the legacy collapse: pre-Phase-2 the route
      // mapped every non-embedding inference to ['chat'], so even when
      // inferCapability correctly identified Whisper as audio or
      // o3-mini as reasoning, the dialog pre-checked Chat. Now each
      // capability passes through verbatim.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'whisper-1', name: 'Whisper 1' }),
        makeModelInfo({ id: 'o3-mini', name: 'o3-mini' }),
        makeModelInfo({ id: 'dall-e-3', name: 'DALL·E 3' }),
        makeModelInfo({ id: 'text-moderation-latest', name: 'Moderation' }),
      ]);

      const response = await GET(makeRequest('openai'));
      const data = await parseJson<{
        data: {
          candidates: Array<{
            modelId: string;
            inferredCapability: string;
            suggested: { capabilities: string[] };
          }>;
        };
      }>(response);

      const byId = new Map(data.data.candidates.map((c) => [c.modelId, c]));

      expect(byId.get('whisper-1')?.inferredCapability).toBe('audio');
      expect(byId.get('whisper-1')?.suggested.capabilities).toEqual(['audio']);

      expect(byId.get('o3-mini')?.inferredCapability).toBe('reasoning');
      expect(byId.get('o3-mini')?.suggested.capabilities).toEqual(['reasoning']);

      expect(byId.get('dall-e-3')?.inferredCapability).toBe('image');
      expect(byId.get('dall-e-3')?.suggested.capabilities).toEqual(['image']);

      expect(byId.get('text-moderation-latest')?.inferredCapability).toBe('moderation');
      expect(byId.get('text-moderation-latest')?.suggested.capabilities).toEqual(['moderation']);
    });

    it("emits an empty capabilities array when inference returns 'unknown'", async () => {
      // 'unknown' is catalogue-only; the matrix rejects it. Returning
      // [] forces the operator to pick a capability in the review
      // step before submit (the bulk endpoint's `.min(1)` then enforces).
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'some-mystery-model-xyz', name: 'Mystery' }),
      ]);

      const response = await GET(makeRequest('openai'));
      const data = await parseJson<{
        data: {
          candidates: Array<{
            modelId: string;
            inferredCapability: string;
            suggested: { capabilities: string[] };
          }>;
        };
      }>(response);

      const mystery = data.data.candidates.find((c) => c.modelId === 'some-mystery-model-xyz');
      expect(mystery?.inferredCapability).toBe('unknown');
      expect(mystery?.suggested.capabilities).toEqual([]);
    });

    it('sorts matrix-matched rows ahead of unmatched, then by name', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProvider() as never);
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        { id: 'matrix-1', modelId: 'gpt-4o' },
      ] as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'aaaa', name: 'AAAA' }),
        makeModelInfo({ id: 'gpt-4o', name: 'GPT-4o' }),
        makeModelInfo({ id: 'zzzz', name: 'ZZZZ' }),
      ]);

      const response = await GET(makeRequest('openai'));
      const data = await parseJson<{
        data: { candidates: Array<{ modelId: string; inMatrix: boolean }> };
      }>(response);

      // Matrix match first
      expect(data.data.candidates[0].modelId).toBe('gpt-4o');
      expect(data.data.candidates[0].inMatrix).toBe(true);
      // Then alphabetical for the rest
      expect(data.data.candidates[1].modelId).toBe('aaaa');
      expect(data.data.candidates[2].modelId).toBe('zzzz');
    });
  });
});
