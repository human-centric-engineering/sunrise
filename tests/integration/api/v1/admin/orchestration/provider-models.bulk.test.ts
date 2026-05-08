/**
 * Integration Test: Bulk-create provider models
 *
 * POST /api/v1/admin/orchestration/provider-models/bulk
 *
 * Key behaviours:
 *   - Validates the envelope shape + each row
 *   - Pre-checks for existing (providerSlug, modelId) pairs and
 *     reports them in `conflicts` rather than failing the batch
 *   - createMany with skipDuplicates so partial success is honest
 *   - Auto-derives slug from (providerSlug + modelId)
 *
 * @see app/api/v1/admin/orchestration/provider-models/bulk/route.ts
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
    aiProviderModel: {
      findMany: vi.fn(() => Promise.resolve([])),
      createMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/provider-selector', () => ({
  invalidateModelCache: vi.fn(),
}));

import { POST } from '@/app/api/v1/admin/orchestration/provider-models/bulk/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    modelId: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    description: 'Fast cheap chat model',
    capabilities: ['chat'],
    tierRole: 'worker',
    reasoningDepth: 'medium',
    latency: 'fast',
    costEfficiency: 'very_high',
    contextLength: 'high',
    toolUse: 'strong',
    bestRole: 'Quick worker for tool calls',
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
    url: 'http://localhost:3000/api/v1/admin/orchestration/provider-models/bulk',
  };
  return {
    ...base,
    clone: () => ({ ...base }),
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/provider-models/bulk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const response = await POST(makeRequest({ providerSlug: 'openai', models: [makeRow()] }));
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const response = await POST(makeRequest({ providerSlug: 'openai', models: [makeRow()] }));
      expect(response.status).toBe(403);
    });
  });

  describe('Validation', () => {
    it('returns 400 when providerSlug is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await POST(makeRequest({ models: [makeRow()] }));
      expect(response.status).toBe(400);
    });

    it('returns 400 when models array is empty', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await POST(makeRequest({ providerSlug: 'openai', models: [] }));
      expect(response.status).toBe(400);
    });

    it('returns 400 when a row is missing required fields', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await POST(
        makeRequest({
          providerSlug: 'openai',
          models: [{ modelId: 'gpt-4o' }], // missing tierRole, etc
        })
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when more than 50 models are submitted', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const tooMany = Array.from({ length: 51 }, (_, i) => makeRow({ modelId: `gpt-clone-${i}` }));
      const response = await POST(makeRequest({ providerSlug: 'openai', models: tooMany }));
      expect(response.status).toBe(400);
    });
  });

  describe('Successful bulk create', () => {
    it('creates all rows when none conflict', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiProviderModel.createMany).mockResolvedValue({ count: 3 } as never);

      const response = await POST(
        makeRequest({
          providerSlug: 'openai',
          models: [
            makeRow({ modelId: 'gpt-4o-mini', name: 'GPT-4o mini' }),
            makeRow({ modelId: 'gpt-4o', name: 'GPT-4o' }),
            makeRow({ modelId: 'gpt-5', name: 'GPT-5' }),
          ],
        })
      );

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: { created: number; skipped: number; conflicts: Array<{ modelId: string }> };
      }>(response);
      expect(data.data.created).toBe(3);
      expect(data.data.skipped).toBe(0);
      expect(data.data.conflicts).toEqual([]);
    });

    it('reports partial success when some rows already exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // 2 of the 3 already in matrix (both active — so the conflict
      // reason should be `already_in_matrix`, not `..._inactive`).
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        { modelId: 'gpt-4o', isActive: true },
        { modelId: 'gpt-5', isActive: true },
      ] as never);
      vi.mocked(prisma.aiProviderModel.createMany).mockResolvedValue({ count: 1 } as never);

      const response = await POST(
        makeRequest({
          providerSlug: 'openai',
          models: [
            makeRow({ modelId: 'gpt-4o-mini', name: 'GPT-4o mini' }),
            makeRow({ modelId: 'gpt-4o', name: 'GPT-4o' }),
            makeRow({ modelId: 'gpt-5', name: 'GPT-5' }),
          ],
        })
      );

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: {
          created: number;
          skipped: number;
          conflicts: Array<{ modelId: string; reason: string }>;
        };
      }>(response);
      expect(data.data.created).toBe(1);
      expect(data.data.skipped).toBe(2);
      expect(data.data.conflicts).toHaveLength(2);
      expect(data.data.conflicts.map((c) => c.modelId).sort()).toEqual(['gpt-4o', 'gpt-5']);
      expect(data.data.conflicts[0].reason).toBe('already_in_matrix');

      // Only the non-conflict row should be passed to createMany.
      const createCall = vi.mocked(prisma.aiProviderModel.createMany).mock.calls[0]?.[0];
      const insertedIds = (createCall?.data as Array<{ modelId: string }>).map((r) => r.modelId);
      expect(insertedIds).toEqual(['gpt-4o-mini']);
    });

    it('reports all-conflict batch as 0 created / N skipped', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        { modelId: 'gpt-4o-mini', isActive: true },
        { modelId: 'gpt-4o', isActive: true },
      ] as never);
      vi.mocked(prisma.aiProviderModel.createMany).mockResolvedValue({ count: 0 } as never);

      const response = await POST(
        makeRequest({
          providerSlug: 'openai',
          models: [makeRow({ modelId: 'gpt-4o-mini' }), makeRow({ modelId: 'gpt-4o' })],
        })
      );

      expect(response.status).toBe(201);
      const data = await parseJson<{ data: { created: number; skipped: number } }>(response);
      expect(data.data.created).toBe(0);
      expect(data.data.skipped).toBe(2);
    });

    it('derives slug from (providerSlug + modelId)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiProviderModel.createMany).mockResolvedValue({ count: 1 } as never);

      await POST(
        makeRequest({
          providerSlug: 'openai',
          models: [makeRow({ modelId: 'gpt-4.1', name: 'GPT-4.1' })],
        })
      );

      const call = vi.mocked(prisma.aiProviderModel.createMany).mock.calls[0]?.[0];
      const inserted = (call?.data as Array<{ slug: string; modelId: string }>)[0];
      expect(inserted.slug).toBe('openai-gpt-4-1'); // dot collapses to hyphen
      expect(inserted.modelId).toBe('gpt-4.1');
    });

    it('marks isDefault false and isActive true on created rows', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiProviderModel.createMany).mockResolvedValue({ count: 1 } as never);

      await POST(makeRequest({ providerSlug: 'openai', models: [makeRow()] }));

      const call = vi.mocked(prisma.aiProviderModel.createMany).mock.calls[0]?.[0];
      const inserted = (call?.data as Array<{ isDefault: boolean; isActive: boolean }>)[0];
      expect(inserted.isDefault).toBe(false);
      expect(inserted.isActive).toBe(true);
    });

    it('flags inactive conflicts with the already_in_matrix_inactive reason', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // Inactive (soft-deleted) row blocks re-add. Discovery filters
      // these out so the operator sees them as "Discovered", but the
      // unique constraint still applies; the bulk endpoint surfaces
      // the deactivation explicitly so the dialog can prompt for
      // reactivation instead of letting the row silently skip.
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        { modelId: 'gpt-4o-mini', isActive: false },
      ] as never);
      vi.mocked(prisma.aiProviderModel.createMany).mockResolvedValue({ count: 0 } as never);

      const response = await POST(
        makeRequest({
          providerSlug: 'openai',
          models: [makeRow({ modelId: 'gpt-4o-mini', name: 'GPT-4o mini' })],
        })
      );

      expect(response.status).toBe(201);
      const data = await parseJson<{
        data: {
          created: number;
          skipped: number;
          conflicts: Array<{ modelId: string; reason: string }>;
        };
      }>(response);
      expect(data.data.created).toBe(0);
      expect(data.data.skipped).toBe(1);
      expect(data.data.conflicts).toEqual([
        { modelId: 'gpt-4o-mini', reason: 'already_in_matrix_inactive' },
      ]);
      // Pre-detected — must NOT be passed to createMany. Otherwise the
      // unique constraint would silently drop and the count math
      // would still work but for the wrong reason.
      const createCall = vi.mocked(prisma.aiProviderModel.createMany).mock.calls[0]?.[0];
      expect((createCall?.data as Array<unknown>) ?? []).toHaveLength(0);
    });
  });
});
