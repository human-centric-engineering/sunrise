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
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/llm/provider-selector', () => ({
  invalidateModelCache: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

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
    costEfficiency: 'low',
    contextLength: 'very_large',
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
    createdAt: new Date(),
    updatedAt: new Date(),
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
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].configured).toBe(true);
      expect(data.data[0].configuredActive).toBe(true);
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
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await POST(makePostRequest(validBody));
    expect(response.status).toBe(429);
  });
});
