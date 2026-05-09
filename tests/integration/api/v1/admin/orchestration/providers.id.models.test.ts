/**
 * Integration Test: Per-provider live model listing
 *
 * GET /api/v1/admin/orchestration/providers/:id/models
 *
 * Key behaviours:
 *   - Returns the provider's live model list via getProvider(slug).listModels()
 *   - Returns 503 when listModels() throws (provider unreachable)
 *
 * @see app/api/v1/admin/orchestration/providers/[id]/models/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/providers/[id]/models/route';
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
    aiAgent: {
      findMany: vi.fn(() => Promise.resolve([])),
    },
  },
}));

const mockListModels = vi.fn();

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(() => Promise.resolve({ listModels: mockListModels })),
  isApiKeyEnvVarSet: vi.fn(() => true),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { getProvider, isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeModelInfo(overrides: Partial<{ id: string; name: string }> = {}) {
  return {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    provider: 'openai',
    tier: 'worker' as const,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6,
    maxContext: 128000,
    supportsTools: true,
    ...overrides,
  };
}

function makeProviderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER_ID,
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    baseUrl: null,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    isLocal: false,
    isActive: true,
    metadata: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/providers/${PROVIDER_ID}/models`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/providers/:id/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: API key is present. Individual tests override when needed.
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('CUID validation', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });
  });

  describe('Provider lookup', () => {
    it('returns 404 when provider row not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(null);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(404);
    });
  });

  describe('API key missing', () => {
    it('returns 422 when the provider API key env var is not set', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(false);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(422);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('API_KEY_MISSING');
      // Should NOT attempt the live API call
      expect(mockListModels).not.toHaveBeenCalled();
    });
  });

  describe('Local provider (no API key)', () => {
    it('returns models for local provider without API key', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(
        makeProviderRow({
          name: 'Ollama',
          slug: 'ollama-local',
          providerType: 'openai-compatible',
          baseUrl: 'http://localhost:11434/v1',
          apiKeyEnvVar: null,
          isLocal: true,
        }) as never
      );
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(false);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'llama3', name: 'Llama 3' }),
        makeModelInfo({ id: 'mistral', name: 'Mistral' }),
      ]);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(200);
      const body = await parseJson<{
        success: boolean;
        data: { models: Array<{ id: string }> };
      }>(response);
      expect(body.success).toBe(true);
      expect(body.data.models).toHaveLength(2);
    });
  });

  describe('Successful model listing', () => {
    it('returns provider models list', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }),
        makeModelInfo({ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }),
      ]);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { providerId: string; slug: string; models: Array<{ id: string }> };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.providerId).toBe(PROVIDER_ID);
      expect(data.data.slug).toBe('anthropic');
      expect(data.data.models.map((m) => m.id)).toContain('claude-sonnet-4-6');
    });

    it('calls getProvider with the provider slug from the database row', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      mockListModels.mockResolvedValue([]);

      await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(vi.mocked(getProvider)).toHaveBeenCalledWith('anthropic');
    });
  });

  describe('Matrix annotation', () => {
    it('marks live models that have a matching matrix row', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(
        makeProviderRow({ slug: 'openai' }) as never
      );
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        {
          id: 'matrix-row-1',
          modelId: 'gpt-4o-mini',
          capabilities: ['chat'],
          tierRole: 'worker',
        },
      ] as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }),
        makeModelInfo({ id: 'gpt-4o', name: 'GPT-4o' }),
      ]);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));
      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { models: Array<{ id: string; inMatrix: boolean; matrixId: string | null }> };
      }>(response);

      const matched = data.data.models.find((m) => m.id === 'gpt-4o-mini');
      const unmatched = data.data.models.find((m) => m.id === 'gpt-4o');

      expect(matched?.inMatrix).toBe(true);
      expect(matched?.matrixId).toBe('matrix-row-1');
      expect(unmatched?.inMatrix).toBe(false);
      expect(unmatched?.matrixId).toBe(null);
    });

    it('infers a capability for unmatched models so the panel can route the test button', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(
        makeProviderRow({ slug: 'openai' }) as never
      );
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }),
        makeModelInfo({ id: 'text-embedding-3-small', name: 'text-embedding-3-small' }),
        makeModelInfo({ id: 'o3-pro-2025-06-10', name: 'o3-pro' }),
        makeModelInfo({ id: 'dall-e-3', name: 'DALL-E 3' }),
      ]);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));
      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { models: Array<{ id: string; capabilities: string[] }> };
      }>(response);

      const byId = new Map(data.data.models.map((m) => [m.id, m.capabilities]));
      expect(byId.get('gpt-4o-mini')).toEqual(['chat']);
      expect(byId.get('text-embedding-3-small')).toEqual(['embedding']);
      expect(byId.get('o3-pro-2025-06-10')).toEqual(['reasoning']);
      expect(byId.get('dall-e-3')).toEqual(['image']);
    });

    it('annotates each model with the active agents bound to it', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(
        makeProviderRow({ slug: 'openai' }) as never
      );
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
        { id: 'agent-1', name: 'Triage Bot', slug: 'triage-bot', model: 'gpt-4o-mini' },
        { id: 'agent-2', name: 'Researcher', slug: 'researcher', model: 'gpt-4o-mini' },
        { id: 'agent-3', name: 'Summariser', slug: 'summariser', model: 'gpt-4o' },
      ] as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }),
        makeModelInfo({ id: 'gpt-4o', name: 'GPT-4o' }),
        makeModelInfo({ id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }),
      ]);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));
      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: {
          models: Array<{
            id: string;
            agents: Array<{ id: string; name: string; slug: string }>;
          }>;
        };
      }>(response);

      const byId = new Map(data.data.models.map((m) => [m.id, m.agents]));
      expect(byId.get('gpt-4o-mini')).toHaveLength(2);
      expect(
        byId
          .get('gpt-4o-mini')
          ?.map((a) => a.slug)
          .sort()
      ).toEqual(['researcher', 'triage-bot']);
      expect(byId.get('gpt-4o')?.map((a) => a.slug)).toEqual(['summariser']);
      // Models with no bound agent get an empty array, not undefined,
      // so the panel can render `0` without conditional checks.
      expect(byId.get('gpt-3.5-turbo')).toEqual([]);

      // Query is filtered by provider slug + isActive — never a
      // cross-provider scan.
      expect(vi.mocked(prisma.aiAgent.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { provider: 'openai', isActive: true },
        })
      );
    });

    it('matrix capabilities take precedence over inference', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(
        makeProviderRow({ slug: 'openai' }) as never
      );
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        {
          id: 'matrix-1',
          modelId: 'text-embedding-3-small',
          // Suppose the matrix has a custom capability list — it must
          // win over the inference fallback.
          capabilities: ['embedding', 'rerank'],
          tierRole: 'embedding',
        },
      ] as never);
      mockListModels.mockResolvedValue([
        makeModelInfo({ id: 'text-embedding-3-small', name: 'text-embedding-3-small' }),
      ]);

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));
      const data = await parseJson<{
        data: { models: Array<{ id: string; capabilities: string[]; tierRole: string | null }> };
      }>(response);

      expect(data.data.models[0].capabilities).toEqual(['embedding', 'rerank']);
      expect(data.data.models[0].tierRole).toBe('embedding');
    });
  });

  describe('Provider unavailable', () => {
    it('returns 503 when listModels throws', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      mockListModels.mockRejectedValue(
        new Error('ECONNREFUSED 10.0.0.1:8080 internal-hostname.corp')
      );

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(503);
      const data = await parseJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('PROVIDER_UNAVAILABLE');
      // The raw SDK error must NOT leak through — it would be a
      // blind-SSRF exfiltration oracle for the configured baseUrl.
      expect(data.error.message).not.toContain('10.0.0.1');
      expect(data.error.message).not.toContain('internal-hostname');
      expect(data.error.message).not.toContain('ECONNREFUSED');
    });

    it('returns 503 when getProvider throws', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(makeProviderRow() as never);
      vi.mocked(getProvider).mockRejectedValue(new Error('Provider not found'));

      const response = await GET(makeGetRequest(), makeParams(PROVIDER_ID));

      expect(response.status).toBe(503);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('PROVIDER_UNAVAILABLE');
    });
  });
});
