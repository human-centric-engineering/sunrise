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
 *   - DELETE hard-deletes (removes the row), refused with 409 when any
 *     active agent or active workflow still references the model
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
      delete: vi.fn(),
    },
    aiProviderConfig: {
      findFirst: vi.fn(),
    },
    aiAgent: {
      findMany: vi.fn(() => Promise.resolve([])),
    },
    aiWorkflow: {
      findMany: vi.fn(() => Promise.resolve([])),
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

  // Single-field PATCH cases share an identical shape: mock findUnique
  // → mock update with one changed field → assert 200 + Prisma update
  // received that field. it.each keeps the contract surface explicit
  // (one row per supported field) without duplicating the wiring 12
  // times. Compound-field cases (dimensions+schema+cost; meta block)
  // stay as their own it() blocks below since they exercise multi-
  // field payloads.
  const singleFieldCases = [
    { field: 'slug', value: 'anthropic-claude-opus-4-updated' },
    { field: 'modelId', value: 'claude-opus-4-5' },
    { field: 'description', value: 'Updated desc' },
    { field: 'tierRole', value: 'worker' },
    { field: 'reasoningDepth', value: 'high' },
    { field: 'latency', value: 'fast' },
    { field: 'costEfficiency', value: 'high' },
    { field: 'contextLength', value: 'high' },
    { field: 'toolUse', value: 'moderate' },
    { field: 'bestRole', value: 'Code generation' },
    { field: 'capabilities', value: ['chat', 'embedding'] },
    { field: 'capabilities', value: ['audio'] },
    { field: 'capabilities', value: ['reasoning'] },
    { field: 'capabilities', value: ['image'] },
    { field: 'capabilities', value: ['moderation'] },
    { field: 'isActive', value: false },
  ] as const;

  it.each(singleFieldCases)('updates $field field and returns 200', async ({ field, value }) => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false, isActive: true });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      [field]: value,
    } as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { [field]: value }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ [field]: value }) })
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

  it("returns 400 when capabilities=['unknown'] (catalogue-only value)", async () => {
    // `unknown` is the inferred-capability placeholder; the matrix
    // must refuse it so audits/inventory stay clean.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModel({ isDefault: false }) as never
    );

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { capabilities: ['unknown'] }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(400);
    const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR when slug is already taken (P2002)', async () => {
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

  it('hard-deletes the row when nothing references it', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(makeModel() as never);
    vi.mocked(prisma.aiProviderModel.delete).mockResolvedValue(makeModel() as never);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(200);

    const data = await parseJson<{ data: { id: string; deleted: boolean } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.data.deleted).toBe(true);

    expect(prisma.aiProviderModel.delete).toHaveBeenCalledWith({ where: { id: MODEL_ID } });
    // Hard-delete must not silently fall back to a soft-delete update.
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(429);
  });

  it('returns 409 with bound agents when an active agent uses the model', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModel({ providerSlug: 'openai', modelId: 'gpt-4o-mini' }) as never
    );
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      { id: 'agent-1', name: 'Triage Bot', slug: 'triage-bot' },
      { id: 'agent-2', name: 'Researcher', slug: 'researcher' },
    ] as never);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(409);

    const body = await parseJson<{
      success: boolean;
      error: {
        code: string;
        message: string;
        details: {
          agents: Array<{ id: string; name: string; slug: string }>;
          workflows: Array<{ id: string; name: string; slug: string }>;
        };
      };
    }>(response);

    expect(body.success).toBe(false);
    expect(body.error.code).toBe('MODEL_IN_USE');
    expect(body.error.details.agents).toHaveLength(2);
    expect(body.error.details.agents.map((a) => a.slug)).toEqual(['triage-bot', 'researcher']);
    expect(body.error.details.workflows).toEqual([]);
    // The DB delete must be skipped — this is the whole point of the guard.
    expect(prisma.aiProviderModel.delete).not.toHaveBeenCalled();

    // The agent lookup must be scoped to the same (provider, model) pair
    // as the matrix row — never a cross-provider scan.
    expect(prisma.aiAgent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, provider: 'openai', model: 'gpt-4o-mini' },
      })
    );
  });

  it('returns 409 with bound workflows when a workflow pins the model via modelOverride', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModel({ providerSlug: 'openai', modelId: 'gpt-4o-mini' }) as never
    );
    // No agents bound, but two active workflows pin the model — one in
    // its published version, one in its in-progress draft.
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([
      {
        id: 'wf-1',
        name: 'Support Router',
        slug: 'support-router',
        draftDefinition: null,
        publishedVersion: {
          snapshot: {
            steps: [{ id: 's1', type: 'llm_call', config: { modelOverride: 'gpt-4o-mini' } }],
          },
        },
      },
      {
        id: 'wf-2',
        name: 'Refund Flow',
        slug: 'refund-flow',
        draftDefinition: {
          steps: [{ id: 's1', type: 'route', config: { modelOverride: 'gpt-4o-mini' } }],
        },
        publishedVersion: null,
      },
      {
        // Pins a different model — must not be reported as a blocker.
        id: 'wf-3',
        name: 'Unrelated',
        slug: 'unrelated',
        draftDefinition: null,
        publishedVersion: {
          snapshot: {
            steps: [{ id: 's1', type: 'llm_call', config: { modelOverride: 'claude-haiku' } }],
          },
        },
      },
    ] as never);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(409);

    const body = await parseJson<{
      success: boolean;
      error: {
        code: string;
        details: {
          agents: Array<{ slug: string }>;
          workflows: Array<{ id: string; name: string; slug: string }>;
        };
      };
    }>(response);

    expect(body.error.code).toBe('MODEL_IN_USE');
    expect(body.error.details.workflows.map((w) => w.slug)).toEqual([
      'support-router',
      'refund-flow',
    ]);
    expect(prisma.aiProviderModel.delete).not.toHaveBeenCalled();
  });

  it('hard-deletes when no active agent or workflow references the model', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(makeModel() as never);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiProviderModel.delete).mockResolvedValue(makeModel() as never);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.delete).toHaveBeenCalledWith({ where: { id: MODEL_ID } });
  });
});
