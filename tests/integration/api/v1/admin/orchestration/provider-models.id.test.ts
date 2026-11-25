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
 *   - PATCH sets and clears a vendor retirement and its same-provider
 *     replacement (§136 t-1064), refusing a replacement that breaks the
 *     rule, and writes an admin audit row naming each changed field
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
      findMany: vi.fn(() => Promise.resolve([])),
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
    aiAdminAuditLog: {
      create: vi.fn(() => Promise.resolve({})),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/provider-selector', () => ({
  invalidateModelCache: vi.fn(),
}));

// The install settings the model's uses read (§136 t-1065): nothing pinned
// unless a test says so.
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: vi.fn(() =>
    Promise.resolve({
      defaultModels: { routing: '', chat: '', reasoning: '', embeddings: '', audio: '' },
      defaultModelsStored: {},
      confidentialModel: null,
      activeEmbeddingModelId: null,
    })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

// The real in-use check runs (against the mocked client, at single); a test
// overrides one answer to stand in for another org's usage at multi (t-731).
vi.mock('@/lib/orchestration/admin/global-config-usage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/orchestration/admin/global-config-usage')>();
  return { ...actual, providerModelUsage: vi.fn(actual.providerModelUsage) };
});

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { providerModelUsage } from '@/lib/orchestration/admin/global-config-usage';
import { uniqueViolationError } from '@/tests/helpers/prisma-errors';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import {
  __resetAppModelPinsForTests,
  registerModelPinMover,
  registerModelPinReporter,
} from '@/lib/orchestration/model-lifecycle/app-pins';

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
    inputCostPerMillionTokens: null,
    outputCostPerMillionTokens: null,
    hasFreeTier: null,
    local: false,
    quality: null,
    strengths: null,
    setup: null,
    isDefault: true,
    isActive: true,
    retiresAt: null,
    replacementId: null,
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
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);

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

describe('GET /provider-models/:id — lifecycle and uses (§136 t-1065)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(null);
  });

  type Body = {
    data: {
      replacement?: unknown;
      lifecycle: { state: string; replacement: { id: string; name: string } | null };
      uses: {
        agents: Array<{ name: string; followsPlatform: boolean }>;
        workflows: Array<{ name: string }>;
        settings: Array<{ slot: string; source: string; movedBy?: string }>;
      };
    };
  };

  it('reports a retiring model and its successor, without the raw relation', async () => {
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue({
      ...makeModel({ retiresAt: new Date('2099-03-01T00:00:00Z'), replacementId: 'cm_b' }),
      replacement: {
        id: 'cm_b',
        name: 'Claude Opus 5',
        modelId: 'claude-opus-5',
        isActive: true,
        retiresAt: null,
      },
    } as never);

    const body = await parseJson<Body>(await GET(makeGetRequest(MODEL_ID), routeContext(MODEL_ID)));

    expect(body.data.lifecycle).toEqual({
      state: 'retiring',
      replacement: {
        id: 'cm_b',
        name: 'Claude Opus 5',
        modelId: 'claude-opus-5',
        isActive: true,
        retiresAt: null,
      },
    });
    expect(body.data).not.toHaveProperty('replacement');
  });

  it('lists agents, marking those whose model follows the platform, and workflows', async () => {
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue({
      ...makeModel(),
      replacement: null,
    } as never);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValueOnce([
      {
        id: 'a1',
        name: 'Cleanup',
        slug: 'cleanup-agent',
        orgId: null,
        isSystem: true,
        bindingOwner: 'platform',
      },
      {
        id: 'a2',
        name: 'Support',
        slug: 'support',
        orgId: null,
        isSystem: false,
        bindingOwner: null,
      },
      // A platform agent the org has taken over stays where it is.
      {
        id: 'a3',
        name: 'Advisor',
        slug: 'advisor',
        orgId: null,
        isSystem: true,
        bindingOwner: 'org',
      },
    ] as never);
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValueOnce([
      {
        id: 'w1',
        name: 'Triage',
        slug: 'triage',
        orgId: null,
        draftDefinition: {
          steps: [{ type: 'llm_call', config: { modelOverride: 'claude-opus-4' } }],
        },
        publishedVersion: null,
      },
    ] as never);

    const body = await parseJson<Body>(await GET(makeGetRequest(MODEL_ID), routeContext(MODEL_ID)));

    expect(body.data.uses.agents).toEqual([
      { id: 'a1', name: 'Cleanup', slug: 'cleanup-agent', followsPlatform: true },
      { id: 'a2', name: 'Support', slug: 'support', followsPlatform: false },
      { id: 'a3', name: 'Advisor', slug: 'advisor', followsPlatform: false },
    ]);
    expect(body.data.uses.workflows.map((w) => w.name)).toEqual(['Triage']);
  });

  it('lists the settings that name it, saved or suggested, with embedding pins left to §132', async () => {
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue({
      ...makeModel(),
      replacement: null,
    } as never);
    vi.mocked(getOrchestrationSettings).mockResolvedValueOnce({
      defaultModels: {
        routing: 'claude-haiku',
        chat: 'claude-opus-4',
        reasoning: 'claude-opus-4',
        embeddings: 'claude-opus-4',
        audio: '',
      },
      defaultModelsStored: { chat: 'claude-opus-4' },
      confidentialModel: { providerSlug: 'anthropic', model: 'claude-opus-4' },
      activeEmbeddingModelId: MODEL_ID,
    } as never);

    const body = await parseJson<Body>(await GET(makeGetRequest(MODEL_ID), routeContext(MODEL_ID)));

    expect(body.data.uses.settings).toEqual([
      { slot: 'chat', source: 'saved', byIdOnly: true },
      { slot: 'reasoning', source: 'suggested', byIdOnly: true },
      { slot: 'embeddings', source: 'suggested', movedBy: 'embedding_switch', byIdOnly: true },
      { slot: 'confidential', source: 'saved' },
      { slot: 'active_embedding', source: 'saved', movedBy: 'embedding_switch' },
    ]);
  });

  it('reports nothing for a model nothing uses', async () => {
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue({
      ...makeModel(),
      replacement: null,
    } as never);

    const body = await parseJson<Body>(await GET(makeGetRequest(MODEL_ID), routeContext(MODEL_ID)));

    expect(body.data.lifecycle).toEqual({ state: 'current', replacement: null });
    expect(body.data.uses).toMatchObject({ agents: [], workflows: [], settings: [] });
  });
});

describe('PATCH /api/v1/admin/orchestration/provider-models/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when model not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);

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

  it('skips prisma.update on empty PATCH body for an admin-customised row', async () => {
    // Source: route.ts:101-106 — when the body has no user fields AND
    // the row is already `isDefault: false`, the handler returns early
    // with the current row. Verifies the no-op short-circuit.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);

    const response = await PATCH(makePatchRequest(MODEL_ID, {}), routeContext(MODEL_ID));

    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
  });

  it('writes isDefault:false on empty PATCH body for a seed-managed row', async () => {
    // Counter-test to the no-op skip: a seed row (isDefault: true)
    // receiving an empty PATCH still triggers an update so future
    // `npm run db:seed` runs leave it alone. Locks in the
    // `if (current.isDefault) data.isDefault = false;` branch at L97-99.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: true });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue({
      ...existing,
      isDefault: false,
    } as never);

    const response = await PATCH(makePatchRequest(MODEL_ID, {}), routeContext(MODEL_ID));

    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isDefault: false }) })
    );
  });

  it('returns 400 VALIDATION_ERROR when slug is already taken (P2002)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);

    const p2002 = uniqueViolationError({
      index: 'ai_provider_model_slug_key',
      modelName: 'AiProviderModel',
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

  it('does not answer the slug message for a P2002 on another constraint (t-814)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);

    const p2002 = uniqueViolationError({
      index: 'some_other_key',
      modelName: 'AiProviderModel',
    });
    vi.mocked(prisma.aiProviderModel.update).mockRejectedValue(p2002);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { slug: 'duplicate-slug' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(400);
    const otherData = await parseJson<{
      error: { code: string; message: string; details?: unknown };
    }>(response);
    expect(otherData.error.code).toBe('VALIDATION_ERROR');
    expect(otherData.error.message).toBe('A record with that value already exists');
    expect(otherData.error.details).toBeUndefined();
  });

  it('names the provider and model id for a P2002 on that pair (t-814)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);

    const p2002 = uniqueViolationError({
      index: 'ai_provider_model_providerSlug_modelId_key',
      modelName: 'AiProviderModel',
    });
    vi.mocked(prisma.aiProviderModel.update).mockRejectedValue(p2002);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { slug: 'duplicate-slug' }),
      routeContext(MODEL_ID)
    );
    expect(response.status).toBe(400);
    const otherData = await parseJson<{
      error: { code: string; message: string; details?: unknown };
    }>(response);
    expect(otherData.error.code).toBe('VALIDATION_ERROR');
    expect(otherData.error.message).toBe('This provider already has a model with that model id');
    expect(otherData.error.details).toEqual({ modelId: ['Already in use for this provider'] });
  });
});

describe('PATCH split input/output prices (t-774)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function patchWith(current: Record<string, unknown>, body: Record<string, unknown>) {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false, ...current });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue(existing as never);
    return PATCH(makePatchRequest(MODEL_ID, body), routeContext(MODEL_ID));
  }

  it('passes both prices through to prisma.update when set together', async () => {
    const response = await patchWith(
      {},
      { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 }
    );

    expect(response.status).toBe(200);
    const data = vi.mocked(prisma.aiProviderModel.update).mock.calls[0][0].data;
    expect(data.inputCostPerMillionTokens).toBe(3);
    expect(data.outputCostPerMillionTokens).toBe(15);
  });

  it('answers 400, not 500, when the database refuses half a price after a race', async () => {
    // Two PATCHes can each pass the route's check against the same saved
    // row; the CHECK constraint refuses the second. Shape measured against
    // the dev DB: P2039 naming `ai_provider_model_price_pair`.
    const { Prisma } = await import('@prisma/client');
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModel({
        isDefault: false,
        inputCostPerMillionTokens: 3,
        outputCostPerMillionTokens: 15,
      }) as never
    );
    vi.mocked(prisma.aiProviderModel.update).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Database error. Code: `23514`. Message: `new row for relation "ai_provider_model" violates check constraint "ai_provider_model_price_pair"`',
        { code: 'P2039', clientVersion: 'test' }
      )
    );

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { inputCostPerMillionTokens: 4 }),
      routeContext(MODEL_ID)
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ success: boolean; error: { message: string } }>(response);
    expect(body.error.message).toBe('Set the input and output prices together, or neither');
  });

  it('rejects an input-only price when the saved row has neither', async () => {
    const response = await patchWith({}, { inputCostPerMillionTokens: 3 });

    expect(response.status).toBe(400);
    const body = await parseJson<{
      success: boolean;
      error: { code: string; details: Record<string, string[]> };
    }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.outputCostPerMillionTokens).toEqual([
      'Set the input and output prices together, or neither',
    ]);
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
  });

  it('rejects an output-only price when the saved row has neither', async () => {
    const response = await patchWith({}, { outputCostPerMillionTokens: 15 });

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { details: Record<string, string[]> } }>(response);
    expect(body.error.details.inputCostPerMillionTokens).toEqual([
      'Set the input and output prices together, or neither',
    ]);
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
  });

  it('rejects clearing only the input price when the saved row has both', async () => {
    const response = await patchWith(
      { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 },
      { inputCostPerMillionTokens: null }
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { details: Record<string, string[]> } }>(response);
    expect(body.error.details.inputCostPerMillionTokens).toBeDefined();
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
  });

  it('accepts changing only the input price when the saved row already has both', async () => {
    const response = await patchWith(
      { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 },
      { inputCostPerMillionTokens: 4 }
    );

    expect(response.status).toBe(200);
    const data = vi.mocked(prisma.aiProviderModel.update).mock.calls[0][0].data;
    expect(data.inputCostPerMillionTokens).toBe(4);
    // The untouched half must not be rewritten.
    expect(data).not.toHaveProperty('outputCostPerMillionTokens');
  });

  it('accepts changing only the output price when the saved row already has both', async () => {
    const response = await patchWith(
      { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 },
      { outputCostPerMillionTokens: 20 }
    );

    expect(response.status).toBe(200);
    const data = vi.mocked(prisma.aiProviderModel.update).mock.calls[0][0].data;
    expect(data.outputCostPerMillionTokens).toBe(20);
    expect(data).not.toHaveProperty('inputCostPerMillionTokens');
  });

  it('accepts clearing both prices together, writing null to each', async () => {
    const response = await patchWith(
      { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 },
      { inputCostPerMillionTokens: null, outputCostPerMillionTokens: null }
    );

    expect(response.status).toBe(200);
    const data = vi.mocked(prisma.aiProviderModel.update).mock.calls[0][0].data;
    expect(data.inputCostPerMillionTokens).toBeNull();
    expect(data.outputCostPerMillionTokens).toBeNull();
  });

  it('accepts an unrelated edit on a row that has neither price', async () => {
    const response = await patchWith({}, { name: 'Renamed' });

    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/v1/admin/orchestration/provider-models/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when model not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);

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

  it('writes an admin audit row naming the deleted model (§136 t-1064)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(makeModel() as never);
    vi.mocked(prisma.aiProviderModel.delete).mockResolvedValue(makeModel() as never);

    await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0].data).toMatchObject({
      action: 'provider_model.delete',
      entityType: 'provider_model',
      entityId: MODEL_ID,
      entityName: 'Claude Opus 4',
      metadata: { providerSlug: 'anthropic', modelId: 'claude-opus-4' },
    });
  });

  it('names, in the delete row, the models whose replacement the delete clears', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(makeModel() as never);
    // Answer the replacement lookup; the same-id lookup finds nothing.
    vi.mocked(prisma.aiProviderModel.findMany).mockImplementation(((args: {
      where: { replacementId?: string };
    }) =>
      Promise.resolve(
        args.where.replacementId === MODEL_ID ? [{ id: 'cm_a', name: 'Claude 3 Opus' }] : []
      )) as never);
    vi.mocked(prisma.aiProviderModel.delete).mockResolvedValue(makeModel() as never);

    await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(prisma.aiProviderModel.findMany).toHaveBeenCalledWith({
      where: { replacementId: MODEL_ID },
      select: { id: true, name: true },
    });
    expect(vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0].data.metadata).toEqual({
      providerSlug: 'anthropic',
      modelId: 'claude-opus-4',
      replacementClearedFor: [{ id: 'cm_a', name: 'Claude 3 Opus' }],
    });
  });

  it('writes no audit row when the delete is refused as in use', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(makeModel() as never);
    vi.mocked(providerModelUsage).mockResolvedValueOnce({
      agents: [],
      workflows: [],
      otherOrgAgents: 1,
      otherOrgAgentsFollowingPlatform: 0,
      otherOrgWorkflows: 0,
      otherOrgWorkflowsByIdOnly: 0,
    });

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(409);
    expect(prisma.aiAdminAuditLog.create).not.toHaveBeenCalled();
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

  it('returns 409 when only another org uses the model, naming none of its rows (t-731)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModel({ name: 'GPT-4o mini', providerSlug: 'openai', modelId: 'gpt-4o-mini' }) as never
    );
    vi.mocked(providerModelUsage).mockResolvedValueOnce({
      agents: [],
      workflows: [],
      otherOrgAgents: 1,
      otherOrgAgentsFollowingPlatform: 0,
      otherOrgWorkflows: 2,
      otherOrgWorkflowsByIdOnly: 2,
    });

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(409);
    expect(providerModelUsage).toHaveBeenCalledWith('openai', 'gpt-4o-mini', {});
    expect(prisma.aiProviderModel.delete).not.toHaveBeenCalled();
    const body = await parseJson<{
      error: { code: string; message: string; details: Record<string, unknown> };
    }>(response);
    expect(body.error.code).toBe('MODEL_IN_USE');
    expect(body.error.message).toBe(
      'Cannot delete model "GPT-4o mini" — 1 active agent and 2 active workflows (3 of them in other organisations) still reference it. Re-point them to a different model first.'
    );
    expect(body.error.details).toEqual({
      agents: [],
      workflows: [],
      settings: [],
      otherOrgAgentCount: 1,
      otherOrgWorkflowCount: 2,
    });
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

    // Full error envelope assertion — pattern #9. Without `success`
    // being explicitly checked, a regression that returned a 409 with
    // a truthy `success` (envelope shape drift) would slip past.
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('MODEL_IN_USE');
    expect(body.error.details.workflows.map((w) => w.slug)).toEqual([
      'support-router',
      'refund-flow',
    ]);
    expect(prisma.aiProviderModel.delete).not.toHaveBeenCalled();
  });

  it('definitionPinsModel guards: tolerates malformed steps and non-LLM steps', async () => {
    // Source: route.ts:208-222 — the guards skip non-object steps,
    // missing `type` fields, non-LLM step types, non-object configs,
    // and non-string modelOverride values. Without these guards a
    // malformed workflow definition could spuriously block a delete
    // (or worse: trip a TypeError mid-walk). Each guard branch is
    // exercised by the fixture below; the delete is expected to
    // succeed because no genuine pin exists.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModel({ providerSlug: 'openai', modelId: 'gpt-4o-mini' }) as never
    );
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([
      {
        id: 'wf-malformed',
        name: 'Malformed Workflow',
        slug: 'malformed',
        draftDefinition: {
          steps: [
            null, // L213: non-object step
            'string-step', // L213: non-object step
            { id: 's1' }, // L215: missing type
            { id: 's2', type: 123 }, // L215: non-string type
            { id: 's3', type: 'webhook', config: { modelOverride: 'gpt-4o-mini' } }, // L215: non-LLM type — guarded
            { id: 's4', type: 'llm_call' }, // L217: missing config
            { id: 's5', type: 'llm_call', config: null }, // L217: non-object config
            { id: 's6', type: 'llm_call', config: { modelOverride: 123 } }, // L218-219: non-string override
          ],
        },
        publishedVersion: null,
      },
    ] as never);
    vi.mocked(prisma.aiProviderModel.delete).mockResolvedValue(
      makeModel({ providerSlug: 'openai', modelId: 'gpt-4o-mini' }) as never
    );

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.delete).toHaveBeenCalledWith({ where: { id: MODEL_ID } });
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

describe('PATCH vendor retirement (§136 t-1064)', () => {
  const SUCCESSOR_ID = 'cmjbv4i3x00013wsl0000succ';

  /** An active same-provider successor with every capability of `makeModel()`. */
  function successor(overrides: Record<string, unknown> = {}) {
    return {
      id: SUCCESSOR_ID,
      name: 'Claude Opus 5',
      providerSlug: 'anthropic',
      capabilities: ['chat', 'vision'],
      isActive: true,
      retiresAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * PATCH `body` against a saved row. `findUnique` answers the row itself
   * for its own id and `candidate` for the successor's.
   */
  async function patchWith(
    body: Record<string, unknown>,
    options: { current?: Record<string, unknown>; candidate?: Record<string, unknown> | null } = {}
  ) {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false, ...options.current });
    vi.mocked(prisma.aiProviderModel.findUnique).mockImplementation(((args: {
      where: { id: string };
    }) =>
      Promise.resolve(
        args.where.id === MODEL_ID
          ? existing
          : args.where.id === SUCCESSOR_ID
            ? (options.candidate ?? null)
            : null
      )) as never);
    vi.mocked(prisma.aiProviderModel.update).mockImplementation(((args: {
      data: Record<string, unknown>;
    }) => {
      const replacement = args.data.replacement as
        { connect?: { id: string }; disconnect?: true } | undefined;
      const { replacement: _r, ...rest } = args.data;
      return Promise.resolve({
        ...existing,
        ...rest,
        ...(replacement
          ? { replacementId: replacement.connect ? replacement.connect.id : null }
          : {}),
      });
    }) as never);
    return PATCH(makePatchRequest(MODEL_ID, body), routeContext(MODEL_ID));
  }

  function updateData(): Record<string, unknown> {
    return vi.mocked(prisma.aiProviderModel.update).mock.calls[0][0].data;
  }

  it('stores the retirement day as the UTC midnight that begins it, and the successor', async () => {
    const response = await patchWith(
      { retiresAt: '2027-03-01', replacementId: SUCCESSOR_ID },
      { candidate: successor() }
    );

    expect(response.status).toBe(200);
    const data = updateData();
    expect(data.retiresAt).toEqual(new Date('2027-03-01T00:00:00.000Z'));
    expect(data.replacement).toEqual({ connect: { id: SUCCESSOR_ID } });
  });

  it('writes an admin audit row naming the old and new value of each changed field', async () => {
    await patchWith(
      { retiresAt: '2027-03-01', replacementId: SUCCESSOR_ID },
      { candidate: successor() }
    );

    expect(prisma.aiAdminAuditLog.create).toHaveBeenCalledTimes(1);
    const row = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0].data;
    expect(row).toMatchObject({
      action: 'provider_model.update',
      entityType: 'provider_model',
      entityId: MODEL_ID,
      changes: {
        retiresAt: { from: null, to: '2027-03-01T00:00:00.000Z' },
        replacementId: { from: null, to: SUCCESSOR_ID },
      },
    });
  });

  it('records a price change in the audit row (no separate repriced state)', async () => {
    await patchWith(
      { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 20 },
      { current: { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 } }
    );

    const row = vi.mocked(prisma.aiAdminAuditLog.create).mock.calls[0][0].data;
    expect(row.changes).toEqual({
      inputCostPerMillionTokens: { from: 3, to: 4 },
      outputCostPerMillionTokens: { from: 15, to: 20 },
    });
  });

  it('refuses a replacement on another provider, writing nothing', async () => {
    const response = await patchWith(
      { retiresAt: '2027-03-01', replacementId: SUCCESSOR_ID },
      { candidate: successor({ providerSlug: 'openai', name: 'GPT-5' }) }
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { details: { replacementId: string[] } } }>(response);
    expect(body.error.details.replacementId[0]).toMatch(/same provider \(anthropic\)/);
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
    expect(prisma.aiAdminAuditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    ['is turned off', { isActive: false }, /turned off/],
    ['is itself retiring', { retiresAt: new Date('2027-06-01T00:00:00Z') }, /itself being retired/],
    ['lacks a capability the model has', { capabilities: ['chat'] }, /lacks vision/],
  ])('refuses a replacement that %s', async (_label, overrides, message) => {
    const response = await patchWith(
      { retiresAt: '2027-03-01', replacementId: SUCCESSOR_ID },
      { current: { capabilities: ['chat', 'vision'] }, candidate: successor(overrides) }
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toMatch(message);
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
  });

  it('refuses a replacement that does not exist', async () => {
    const response = await patchWith(
      { retiresAt: '2027-03-01', replacementId: SUCCESSOR_ID },
      { candidate: null }
    );

    expect(response.status).toBe(400);
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
  });

  it('refuses the model as its own replacement', async () => {
    const response = await patchWith(
      { retiresAt: '2027-03-01', replacementId: MODEL_ID },
      { candidate: null }
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toMatch(/cannot replace itself/);
  });

  it('refuses a replacement without a retirement date', async () => {
    const response = await patchWith({ replacementId: SUCCESSOR_ID }, { candidate: successor() });

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toMatch(/retirement date before naming a replacement/);
  });

  it('refuses a day that is not a day', async () => {
    const response = await patchWith({ retiresAt: '2027-02-30' });

    expect(response.status).toBe(400);
    expect(prisma.aiProviderModel.update).not.toHaveBeenCalled();
  });

  it('clearing the date clears the replacement with it', async () => {
    const response = await patchWith(
      { retiresAt: null },
      {
        current: {
          retiresAt: new Date('2027-03-01T00:00:00Z'),
          replacementId: SUCCESSOR_ID,
        },
      }
    );

    expect(response.status).toBe(200);
    expect(updateData()).toMatchObject({ retiresAt: null, replacement: { disconnect: true } });
  });

  it('lets an unrelated edit through when the stored replacement has stopped qualifying', async () => {
    // What the edit form sends on every save: the stored replacement and the
    // unchanged provider and capabilities, beside the field actually edited.
    const response = await patchWith(
      {
        description: 'Edited',
        replacementId: SUCCESSOR_ID,
        providerSlug: 'anthropic',
        capabilities: ['chat'],
      },
      {
        current: {
          retiresAt: new Date('2027-03-01T00:00:00Z'),
          replacementId: SUCCESSOR_ID,
        },
        candidate: successor({ isActive: false }),
      }
    );

    expect(response.status).toBe(200);
    expect(updateData().description).toBe('Edited');
  });

  it('writes no audit row for a save that changed nothing', async () => {
    // The form re-sends the saved values; the update returns the row as it was.
    const response = await patchWith({ name: 'Claude Opus 4', retiresAt: null });

    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.update).toHaveBeenCalled();
    expect(prisma.aiAdminAuditLog.create).not.toHaveBeenCalled();
  });

  it('treats the same capabilities in another order as unchanged', async () => {
    const response = await patchWith(
      { capabilities: ['vision', 'chat'] },
      {
        current: {
          capabilities: ['chat', 'vision'],
          retiresAt: new Date('2027-03-01T00:00:00Z'),
          replacementId: SUCCESSOR_ID,
        },
        candidate: successor({ isActive: false }),
      }
    );

    expect(response.status).toBe(200);
  });

  it('re-checks a stored replacement when the model gains a capability it lacks', async () => {
    const response = await patchWith(
      { capabilities: ['chat', 'vision', 'embedding'] },
      {
        current: {
          capabilities: ['chat', 'vision'],
          retiresAt: new Date('2027-03-01T00:00:00Z'),
          replacementId: SUCCESSOR_ID,
        },
        candidate: successor(),
      }
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toMatch(/lacks embedding/);
  });

  it("re-checks a stored replacement when the model's provider changes", async () => {
    const response = await patchWith(
      { providerSlug: 'openai' },
      {
        current: {
          retiresAt: new Date('2027-03-01T00:00:00Z'),
          replacementId: SUCCESSOR_ID,
        },
        candidate: successor(),
      }
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toMatch(/same provider \(openai\)/);
  });
});

describe('PATCH capabilities (t-1064)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts vision and documents, which the edit form sends for most chat models', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const existing = makeModel({ isDefault: false });
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiProviderModel.update).mockResolvedValue(existing as never);

    const response = await PATCH(
      makePatchRequest(MODEL_ID, { capabilities: ['chat', 'vision', 'documents'] }),
      routeContext(MODEL_ID)
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(prisma.aiProviderModel.update).mock.calls[0][0].data.capabilities).toEqual([
      'chat',
      'vision',
      'documents',
    ]);
  });
});

describe('DELETE refuses while a saved setting names the model (§136 t-1065)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(makeModel() as never);
  });

  function settingsNaming(overrides: Record<string, unknown>) {
    vi.mocked(getOrchestrationSettings).mockResolvedValueOnce({
      defaultModels: { routing: '', chat: '', reasoning: '', embeddings: '', audio: '' },
      defaultModelsStored: {},
      confidentialModel: null,
      activeEmbeddingModelId: null,
      ...overrides,
    } as never);
  }

  it('refuses for the confidential-message model, naming the setting', async () => {
    settingsNaming({ confidentialModel: { providerSlug: 'anthropic', model: 'claude-opus-4' } });

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(409);
    const body = await parseJson<{ error: { message: string; details: { settings: string[] } } }>(
      response
    );
    expect(body.error.details.settings).toEqual(['confidential']);
    expect(body.error.message).toContain('1 saved setting still references it');
    expect(prisma.aiProviderModel.delete).not.toHaveBeenCalled();
  });

  it('refuses for a saved default and the active embedding model', async () => {
    settingsNaming({
      defaultModels: {
        routing: '',
        chat: 'claude-opus-4',
        reasoning: '',
        embeddings: '',
        audio: '',
      },
      defaultModelsStored: { chat: 'claude-opus-4' },
      activeEmbeddingModelId: MODEL_ID,
    });

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(409);
    const body = await parseJson<{ error: { details: { settings: string[] } } }>(response);
    expect(body.error.details.settings).toEqual(['chat', 'active_embedding']);
  });

  it('lists three kinds of use with commas, and keeps settings out of the other-org count', async () => {
    settingsNaming({ confidentialModel: { providerSlug: 'anthropic', model: 'claude-opus-4' } });
    vi.mocked(providerModelUsage).mockResolvedValueOnce({
      agents: [],
      workflows: [],
      otherOrgAgents: 2,
      otherOrgAgentsFollowingPlatform: 0,
      otherOrgWorkflows: 1,
      otherOrgWorkflowsByIdOnly: 1,
    });

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));
    const body = await parseJson<{ error: { message: string } }>(response);

    expect(body.error.message).toBe(
      'Cannot delete model "Claude Opus 4" — 2 active agents, 1 active workflow (3 of them in other organisations) and 1 saved setting still reference it. Re-point them to a different model first.'
    );
  });

  it('allows it when a saved default names the id alone and another active row offers it', async () => {
    settingsNaming({
      defaultModels: {
        routing: '',
        chat: 'claude-opus-4',
        reasoning: '',
        embeddings: '',
        audio: '',
      },
      defaultModelsStored: { chat: 'claude-opus-4' },
    });
    // Another provider's active row with the same id keeps the default working.
    vi.mocked(prisma.aiProviderModel.findMany).mockImplementation(((args: {
      where: { modelId?: string };
    }) =>
      Promise.resolve(
        args.where.modelId === 'claude-opus-4' ? [{ providerSlug: 'bedrock', retiresAt: null }] : []
      )) as never);
    vi.mocked(prisma.aiProviderModel.delete).mockResolvedValue(makeModel() as never);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(200);
  });

  it("allows it when only the system's suggestion names it: nobody chose it", async () => {
    settingsNaming({
      defaultModels: {
        routing: '',
        chat: 'claude-opus-4',
        reasoning: '',
        embeddings: '',
        audio: '',
      },
    });
    vi.mocked(prisma.aiProviderModel.delete).mockResolvedValue(makeModel() as never);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.delete).toHaveBeenCalled();
  });
});

describe('the app’s own uses of the model (§136 t-1067)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(makeModel() as never);
    vi.mocked(prisma.aiProviderModel.delete).mockResolvedValue(makeModel() as never);
    // tests/setup.ts pins lib/app/model-pins.ts empty; each test registers here.
    __resetAppModelPinsForTests();
  });

  it('lists them with the model’s uses', async () => {
    registerModelPinReporter(() => [{ label: 'Panel: Contracts', where: 'Panels › Judge' }]);

    const body = await parseJson<{
      data: { uses: { appPins: unknown; otherOrgAppPins: number; appPinsUnavailable: boolean } };
    }>(await GET(makeGetRequest(MODEL_ID), routeContext(MODEL_ID)));

    expect(body.data.uses.appPins).toEqual([
      { label: 'Panel: Contracts', where: 'Panels › Judge' },
    ]);
    expect(body.data.uses.otherOrgAppPins).toBe(0);
    expect(body.data.uses.appPinsUnavailable).toBe(false);
  });

  it('refuses the delete while the app reports a use, and says so', async () => {
    registerModelPinReporter(() => [{ label: 'Panel: Contracts', where: 'Panels › Judge' }]);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(409);
    const body = await parseJson<{
      error: { code: string; message: string; details: { appPins: unknown } };
    }>(response);
    expect(body.error.code).toBe('MODEL_IN_USE');
    expect(body.error.message).toBe(
      'Cannot delete model "Claude Opus 4" — 1 use the app reports still references it. Re-point them to a different model first. The app moves its own uses itself.'
    );
    expect(body.error.details.appPins).toEqual([
      { label: 'Panel: Contracts', where: 'Panels › Judge' },
    ]);
    expect(prisma.aiProviderModel.delete).not.toHaveBeenCalled();
  });

  it('with a mover, says moving the model’s uses moves the app’s too (t-1088)', async () => {
    registerModelPinReporter(() => [{ label: 'Panel: Contracts', where: 'Panels › Judge' }]);
    registerModelPinMover(() => ({ moved: [] }));

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(409);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toBe(
      'Cannot delete model "Claude Opus 4" — 1 use the app reports still references it. Re-point them to a different model first. Moving the model’s uses moves the app’s uses too.'
    );
    expect(prisma.aiProviderModel.delete).not.toHaveBeenCalled();
  });

  it('refuses the delete while the app’s report failed: it cannot be undone', async () => {
    registerModelPinReporter(() => {
      throw new Error('panel table missing');
    });

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(409);
    const body = await parseJson<{ error: { code: string; message: string } }>(response);
    expect(body.error.code).toBe('MODEL_USES_UNREADABLE');
    expect(body.error.message).toContain('could not all be read, so it may still be in use');
    expect(prisma.aiProviderModel.delete).not.toHaveBeenCalled();
  });

  it('deletes as before when the app reports no use', async () => {
    registerModelPinReporter(() => []);

    const response = await DELETE(makeDeleteRequest(MODEL_ID), routeContext(MODEL_ID));

    expect(response.status).toBe(200);
    expect(prisma.aiProviderModel.delete).toHaveBeenCalled();
  });
});
