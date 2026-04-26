/**
 * Integration Test: Admin Orchestration Provider Model (single)
 *
 * GET    /api/v1/admin/orchestration/provider-models/:id
 * PATCH  /api/v1/admin/orchestration/provider-models/:id
 * DELETE /api/v1/admin/orchestration/provider-models/:id
 *
 * Key assertions:
 *   - GET returns enriched model with configured flag
 *   - PATCH updates fields and sets isDefault=false on seed rows
 *   - DELETE soft-deletes (sets isActive=false)
 *   - 404 for unknown id
 *   - Auth and rate-limiting enforced
 *
 * @see app/api/v1/admin/orchestration/provider-models/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/provider-models/[id]/route';
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
    aiProviderModel: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    aiProviderConfig: {
      findFirst: vi.fn(),
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

const MODEL_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: MODEL_ID,
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

const BASE_URL = 'http://localhost:3000/api/v1/admin/orchestration/provider-models';

function makeGetRequest(id: string): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${id}`));
}

function makePatchRequest(id: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDeleteRequest(id: string): NextRequest {
  return new NextRequest(new URL(`${BASE_URL}/${id}`), { method: 'DELETE' });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/provider-models/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeGetRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(401);
  });

  it('returns 403 when non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await GET(makeGetRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(403);
  });

  it('returns 404 when model not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null as never);

    const response = await GET(makeGetRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(404);
  });

  it('returns enriched model with configured provider info', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(makeModel() as never);
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue({
      slug: 'anthropic',
      isActive: true,
    } as never);

    const response = await GET(makeGetRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(200);

    const data = await parseJson<{
      data: { slug: string; configured: boolean; configuredActive: boolean };
    }>(response);
    expect(data.data.slug).toBe('anthropic-claude-opus-4');
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.data.configured).toBe(true);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.data.configuredActive).toBe(true);
  });
});

describe('PATCH /api/v1/admin/orchestration/provider-models/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  it('returns 404 when model not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { name: 'Updated' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(404);
  });

  it('updates the model and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel();
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      name: 'Updated Name',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { name: 'Updated Name' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);

    const data = await parseJson<{ data: { name: string } }>(response);
    expect(data.data.name).toBe('Updated Name');
  });

  it('sets isDefault to false when editing a seed-managed row', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const seedModel = makeModel({ isDefault: true });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(seedModel as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue(seedModel as never);

    await PATCH(makePatchRequest(MODEL_ID, { name: 'Edited' }), routeContext(MODEL_ID));

    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: false }),
      })
    );
  });

  it('does not set isDefault for already admin-managed rows', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const adminModel = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(adminModel as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue(adminModel as never);

    await PATCH(makePatchRequest(MODEL_ID, { name: 'Edited' }), routeContext(MODEL_ID));

    const callArgs = vi.mocked(prisma.aiProviderModel.update).mock.calls[0][0];
    expect(callArgs.data).not.toHaveProperty('isDefault');
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { name: 'Updated' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(429);
  });

  it('updates slug field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      slug: 'anthropic-claude-opus-4-updated',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { slug: 'anthropic-claude-opus-4-updated' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: 'anthropic-claude-opus-4-updated' }),
      })
    );
  });

  it('updates modelId field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      modelId: 'claude-opus-4-5',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { modelId: 'claude-opus-4-5' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ modelId: 'claude-opus-4-5' }) })
    );
  });

  it('updates description field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      description: 'Updated desc',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { description: 'Updated desc' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ description: 'Updated desc' }) })
    );
  });

  it('updates tierRole field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      tierRole: 'worker',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { tierRole: 'worker' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tierRole: 'worker' }) })
    );
  });

  it('updates reasoningDepth field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      reasoningDepth: 'high',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { reasoningDepth: 'high' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reasoningDepth: 'high' }) })
    );
  });

  it('updates latency field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      latency: 'fast',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { latency: 'fast' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ latency: 'fast' }) })
    );
  });

  it('updates costEfficiency field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      costEfficiency: 'high',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { costEfficiency: 'high' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ costEfficiency: 'high' }) })
    );
  });

  it('updates contextLength field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      contextLength: 'high',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { contextLength: 'high' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contextLength: 'high' }) })
    );
  });

  it('updates toolUse field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      toolUse: 'moderate',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { toolUse: 'moderate' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ toolUse: 'moderate' }) })
    );
  });

  it('updates bestRole field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      bestRole: 'Code generation',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { bestRole: 'Code generation' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bestRole: 'Code generation' }) })
    );
  });

  it('updates capabilities field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      capabilities: ['chat', 'embedding'],
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { capabilities: ['chat', 'embedding'] }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ capabilities: ['chat', 'embedding'] }),
      })
    );
  });

  it('updates isActive field and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false, isActive: true });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      isActive: false,
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { isActive: false }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isActive: false }) })
    );
  });

  it('updates embedding-specific fields (dimensions, schemaCompatible, costPerMillionTokens) and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      dimensions: 1536,
      schemaCompatible: true,
      costPerMillionTokens: 0.02,
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, {
        dimensions: 1536,
        schemaCompatible: true,
        costPerMillionTokens: 0.02,
      }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dimensions: 1536,
          schemaCompatible: true,
          costPerMillionTokens: 0.02,
        }),
      })
    );
  });

  it('updates hasFreeTier, local, quality, strengths, and setup fields and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      hasFreeTier: true,
      local: false,
      quality: 'high',
      strengths: 'Fast retrieval',
      setup: 'Add API key',
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, {
        hasFreeTier: true,
        local: false,
        quality: 'high',
        strengths: 'Fast retrieval',
        setup: 'Add API key',
      }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hasFreeTier: true,
          local: false,
          quality: 'high',
          strengths: 'Fast retrieval',
          setup: 'Add API key',
        }),
      })
    );
  });

  it('returns 409 VALIDATION_ERROR when slug is already taken (P2002)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);

    const { Prisma: ActualPrisma } = await import('@prisma/client');
    const p2002 = new ActualPrisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '7.0.0',
    });
    vi.mocked(prisma.aiProviderModel.update).mockRejectedValue(p2002);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { slug: 'duplicate-slug' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(400);
    const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/v1/admin/orchestration/provider-models/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  it('returns 404 when model not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null as never);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(404);
  });

  it('soft-deletes by setting isActive=false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(makeModel() as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue(
      makeModel({ isActive: false }) as never
    );

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(200);

    const data = await parseJson<{ data: { id: string; deleted: boolean } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.data.deleted).toBe(true);

    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { isActive: false },
      })
    );
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(429);
  });
});
