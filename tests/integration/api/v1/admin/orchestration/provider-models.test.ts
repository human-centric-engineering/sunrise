/**
 * Integration Test: Admin Orchestration Provider Models (list + create)
 *
 * GET  /api/v1/admin/orchestration/provider-models
 * POST /api/v1/admin/orchestration/provider-models
 *
 * Key assertions:
 *   - GET returns paginated list with enrichment (configured, configuredActive)
 *   - GET supports capability, providerSlug, tierRole, isActive, q filters
 *   - POST creates a model row and returns 201
 *   - Slug conflict → 409
 *   - Auth and rate-limiting enforced
 *
 * @see app/api/v1/admin/orchestration/provider-models/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/provider-models/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { Prisma } from '@prisma/client';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    aiProviderConfig: {
      findMany: vi.fn(),
    },
    aiAgent: {
      findMany: vi.fn(() => Promise.resolve([])),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  apiLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/llm/provider-selector', () => ({
  invalidateModelCache: vi.fn(),
}));

// Default-models enrichment pulls from the settings singleton. Stub
// it with an empty merged map by default so existing tests don't see
// any default-role badges; the dedicated test below overrides this.
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: vi.fn(() =>
    Promise.resolve({
      defaultModels: { routing: '', chat: '', reasoning: '', embeddings: '' },
    })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, apiLimiter } from '@/lib/security/rate-limit';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cm_model_001',
    slug: 'anthropic-claude-opus-4',
    providerSlug: 'anthropic',
    modelId: 'claude-opus-4',
    name: 'Claude Opus 4',
    description: 'Frontier reasoning model',
    capabilities: ['chat'],
    tierRole: 'thinking',
    reasoningDepth: 'very_high',
    latency: 'medium',
    costEfficiency: 'medium',
    contextLength: 'very_high',
    toolUse: 'strong',
    bestRole: 'Long-context reasoning',
    dimensions: null,
    schemaCompatible: null,
    costPerMillionTokens: null,
    hasFreeTier: null,
    local: false,
    quality: null,
    strengths: null,
    setup: null,
    isDefault: true,
    isActive: true,
    metadata: null,
    createdBy: ADMIN_ID,
    // Fixed timestamps so the fixture is deterministic — `new Date()`
    // here would surface as a non-deterministic difference the moment a
    // test asserts on the row's date fields.
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/provider-models');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    new URL('http://localhost:3000/api/v1/admin/orchestration/provider-models'),
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
  );
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/provider-models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // GET uses the broader apiLimiter (source route.ts:32). POST uses
    // adminLimiter. Mocking the wrong limiter here means a future
    // refactor that drops the limiter call would not be caught.
    vi.mocked(apiLimiter.check).mockReturnValue({ success: true } as never);
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

    it('returns 429 when apiLimiter trips on GET', async () => {
      // GET calls apiLimiter.check (source route.ts:32); a refactor
      // that no-ops the limiter call would otherwise let infinite
      // anonymous polling slip past. POST has its own 429 test at
      // line 502; this is its GET counterpart.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(apiLimiter.check).mockReturnValueOnce({ success: false } as never);

      const response = await GET(makeGetRequest());
      expect(response.status).toBe(429);
      expect(prisma.aiProviderModel.findMany).not.toHaveBeenCalled();
    });
  });

  describe('List models', () => {
    it('returns paginated list with enrichment', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const model = makeModel();
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([model] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(1 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
        { slug: 'anthropic', isActive: true },
      ] as never);

      const response = await GET(makeGetRequest());
      expect(response.status).toBe(200);

      const data = await parseJson<{
        success: boolean;
        data: Array<{ slug: string; configured: boolean; configuredActive: boolean }>;
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data[0].configured).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data[0].configuredActive).toBe(true);
    });

    it('annotates each row with the active agents bound to it', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        makeModel({ providerSlug: 'openai', modelId: 'gpt-4o-mini' }),
        makeModel({ providerSlug: 'openai', modelId: 'gpt-4o' }),
      ] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(2 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
        { slug: 'openai', isActive: true },
      ] as never);
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
        {
          id: 'agent-1',
          name: 'Triage Bot',
          slug: 'triage-bot',
          provider: 'openai',
          model: 'gpt-4o-mini',
        },
        {
          id: 'agent-2',
          name: 'Researcher',
          slug: 'researcher',
          provider: 'openai',
          model: 'gpt-4o-mini',
        },
      ] as never);

      const response = await GET(makeGetRequest());
      expect(response.status).toBe(200);
      const body = await parseJson<{
        data: Array<{
          modelId: string;
          agents: Array<{ id: string; name: string; slug: string }>;
        }>;
      }>(response);

      const byModelId = new Map(body.data.map((r) => [r.modelId, r.agents]));
      expect(
        byModelId
          .get('gpt-4o-mini')
          ?.map((a) => a.slug)
          .sort()
      ).toEqual(['researcher', 'triage-bot']);
      // Models with no bound agent get an empty array, not undefined,
      // so the matrix can render `0` without conditional checks.
      expect(byModelId.get('gpt-4o')).toEqual([]);
    });

    it('annotates each row with the default-role slots it currently fills', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        makeModel({ providerSlug: 'openai', modelId: 'gpt-4o' }),
        makeModel({ providerSlug: 'openai', modelId: 'gpt-4o-mini' }),
        makeModel({ providerSlug: 'openai', modelId: 'text-embedding-3-small' }),
      ] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(3 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
        { slug: 'openai', isActive: true },
      ] as never);
      // chat + reasoning share a model (gpt-4o), routing points at
      // gpt-4o-mini, embeddings at text-embedding-3-small. Empty-
      // string slots — the registry's `embeddings` fallback when no
      // override is saved — must be ignored so the matrix doesn't
      // claim every row is the embeddings default.
      vi.mocked(getOrchestrationSettings).mockResolvedValue({
        defaultModels: {
          routing: 'gpt-4o-mini',
          chat: 'gpt-4o',
          reasoning: 'gpt-4o',
          embeddings: 'text-embedding-3-small',
        },
      } as never);

      const response = await GET(makeGetRequest());
      const body = await parseJson<{
        data: Array<{ modelId: string; defaultFor: string[] }>;
      }>(response);

      const byId = new Map(body.data.map((r) => [r.modelId, r.defaultFor]));
      // gpt-4o fills two slots; order follows TASK_TYPES.
      expect(byId.get('gpt-4o')?.sort()).toEqual(['chat', 'reasoning']);
      expect(byId.get('gpt-4o-mini')).toEqual(['routing']);
      expect(byId.get('text-embedding-3-small')).toEqual(['embeddings']);
    });

    it('returns empty defaultFor when no default slot points at the row', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        makeModel({ providerSlug: 'openai', modelId: 'gpt-3.5-turbo' }),
      ] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(1 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
      // All slots empty — matches the default-mock at the top of this
      // suite, but stated explicitly here so the empty case is read-
      // able alongside the populated case above.
      vi.mocked(getOrchestrationSettings).mockResolvedValue({
        defaultModels: { routing: '', chat: '', reasoning: '', embeddings: '' },
      } as never);

      const response = await GET(makeGetRequest());
      const body = await parseJson<{ data: Array<{ defaultFor: string[] }> }>(response);
      expect(body.data[0].defaultFor).toEqual([]);
    });

    it('audio defaultFor matches by composite (providerSlug, modelId) — only the right provider lights up', async () => {
      // Regression: pre-fix, the `defaultFor` reverse-index keyed by
      // bare `modelId`, so an `audio: 'whisper-1'` default would
      // light up the badge on BOTH OpenAI's and Groq's `whisper-1`
      // rows. The composite encoding scopes by provider — only the
      // row that actually serves the runtime default gets the badge.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        makeModel({ providerSlug: 'openai', modelId: 'whisper-1', slug: 'openai-whisper-1' }),
        makeModel({ providerSlug: 'groq', modelId: 'whisper-1', slug: 'groq-whisper-1' }),
      ] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(2 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
        { slug: 'openai', isActive: true },
        { slug: 'groq', isActive: true },
      ] as never);
      vi.mocked(getOrchestrationSettings).mockResolvedValue({
        defaultModels: {
          routing: '',
          chat: '',
          reasoning: '',
          embeddings: '',
          // Operator picked "Whisper (groq)" in the form.
          audio: 'groq::whisper-1',
        },
      } as never);

      const response = await GET(makeGetRequest());
      const body = await parseJson<{
        data: Array<{ providerSlug: string; modelId: string; defaultFor: string[] }>;
      }>(response);

      const openai = body.data.find((r) => r.providerSlug === 'openai');
      const groq = body.data.find((r) => r.providerSlug === 'groq');
      expect(groq?.defaultFor).toEqual(['audio']);
      // Critical: OpenAI's identically-named row must NOT light up
      // even though its modelId matches the bare portion of the
      // composite.
      expect(openai?.defaultFor).toEqual([]);
    });

    it('audio defaultFor falls back to modelId-only match for legacy bare-modelId values', async () => {
      // Settings rows written before the composite encoding landed
      // are bare model ids. The matcher's legacy fallback (parser
      // returns providerSlug=null) keeps those rendering their
      // badge — with the historical ambiguity when two providers
      // share an id — until the operator re-saves.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        makeModel({ providerSlug: 'openai', modelId: 'whisper-1', slug: 'openai-whisper-1' }),
      ] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(1 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
        { slug: 'openai', isActive: true },
      ] as never);
      vi.mocked(getOrchestrationSettings).mockResolvedValue({
        defaultModels: {
          routing: '',
          chat: '',
          reasoning: '',
          embeddings: '',
          audio: 'whisper-1', // legacy bare modelId
        },
      } as never);

      const response = await GET(makeGetRequest());
      const body = await parseJson<{ data: Array<{ defaultFor: string[] }> }>(response);
      expect(body.data[0].defaultFor).toEqual(['audio']);
    });

    it('marks unconfigured providers correctly', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([makeModel()] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(1 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);

      const response = await GET(makeGetRequest());
      const data = await parseJson<{ data: Array<{ configured: boolean }> }>(response);
      expect(data.data[0].configured).toBe(false);
    });

    it('passes capability filter to prisma where clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(0 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);

      await GET(makeGetRequest({ capability: 'embedding' }));

      expect(prisma.aiProviderModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            capabilities: { has: 'embedding' },
          }),
        })
      );
    });

    it.each(['reasoning', 'audio', 'image', 'moderation'] as const)(
      'passes widened capability filter %s to prisma where clause',
      async (capability) => {
        vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
        vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
        vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(0 as never);
        vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);

        await GET(makeGetRequest({ capability }));

        expect(prisma.aiProviderModel.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              capabilities: { has: capability },
            }),
          })
        );
      }
    );

    it('rejects ?capability=unknown with 400 (catalogue-only value)', async () => {
      // `unknown` is the inference placeholder. The matrix list endpoint
      // must reject it so a stale catalogue link can't accidentally
      // query the matrix for a value the matrix could never store.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest({ capability: 'unknown' }));
      expect(response.status).toBe(400);
      const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(prisma.aiProviderModel.findMany).not.toHaveBeenCalled();
    });

    it('passes providerSlug filter to prisma where clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(0 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);

      await GET(makeGetRequest({ providerSlug: 'openai' }));

      expect(prisma.aiProviderModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            providerSlug: 'openai',
          }),
        })
      );
    });

    it('passes tierRole filter to prisma where clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(0 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);

      await GET(makeGetRequest({ tierRole: 'thinking' }));

      expect(prisma.aiProviderModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tierRole: 'thinking',
          }),
        })
      );
    });

    it('passes isActive filter to prisma where clause', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(0 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);

      await GET(makeGetRequest({ isActive: 'false' }));

      expect(prisma.aiProviderModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: false,
          }),
        })
      );
    });

    it('applies text search across name, slug, providerSlug, modelId, description', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiProviderModel.count).mockResolvedValue(0 as never);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);

      await GET(makeGetRequest({ q: 'claude' }));

      expect(prisma.aiProviderModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ name: { contains: 'claude', mode: 'insensitive' } }),
            ]),
          }),
        })
      );
    });
  });
});

describe('POST /api/v1/admin/orchestration/provider-models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  const validBody = {
    name: 'GPT-5',
    slug: 'openai-gpt-5',
    providerSlug: 'openai',
    modelId: 'gpt-5',
    description: 'Frontier reasoning model',
    capabilities: ['chat'],
    tierRole: 'thinking',
    reasoningDepth: 'very_high',
    latency: 'medium',
    costEfficiency: 'medium',
    contextLength: 'very_high',
    toolUse: 'strong',
    bestRole: 'Complex reasoning',
    isActive: true,
  };

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await POST(makePostRequest(validBody));
    expect(response.status).toBe(401);
  });

  it('creates a model and returns 201', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const created = makeModel({ ...validBody, id: 'cm_new', isDefault: false });
    vi.mocked(prisma.aiProviderModel.create).mockResolvedValue(created as never);

    const response = await POST(makePostRequest(validBody));
    expect(response.status).toBe(201);

    const data = await parseJson<{ success: boolean; data: { slug: string } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.success).toBe(true);
    expect(data.data.slug).toBe('openai-gpt-5');
  });

  it('sets isDefault to false for admin-created models', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.create).mockResolvedValue(makeModel() as never);

    await POST(makePostRequest(validBody));

    expect(prisma.aiProviderModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: false }),
      })
    );
  });

  it('returns 409 on slug conflict', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const conflictError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '7.0.0',
    });
    vi.mocked(prisma.aiProviderModel.create).mockRejectedValue(conflictError);

    const response = await POST(makePostRequest(validBody));
    expect(response.status).toBe(409);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONFLICT');
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await POST(makePostRequest(validBody));
    expect(response.status).toBe(429);
  });
});
