/**
 * Integration Test: Admin Orchestration — Settings singleton
 *
 * GET   /api/v1/admin/orchestration/settings
 * PATCH /api/v1/admin/orchestration/settings
 *
 * @see app/api/v1/admin/orchestration/settings/route.ts
 *
 * Key assertions:
 *   - Admin auth required on both verbs (401 / 403)
 *   - GET upserts on first call, returns hydrated defaults
 *   - PATCH happy path merges partial updates
 *   - PATCH rejects unknown task-type model ids (400 ValidationError)
 *   - PATCH rejects negative budgets (400 ValidationError)
 *   - PATCH enforces rate limit (429)
 *   - PATCH invalidates the settings cache
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH } from '@/app/api/v1/admin/orchestration/settings/route';
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
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json(
      { success: false, error: { code: 'RATE_LIMITED', message: 'rate limited' } },
      { status: 429 }
    )
  ),
}));

vi.mock('@/lib/orchestration/llm/model-registry', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    computeDefaultModelMap: vi.fn(() => ({
      routing: 'claude-haiku-4-5',
      chat: 'claude-haiku-4-5',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    })),
    validateTaskDefaults: vi.fn((defaults: Record<string, string>) => {
      const errors: Array<{ task: string; message: string }> = [];
      for (const [task, id] of Object.entries(defaults)) {
        if (id === 'not-a-real-model') {
          errors.push({ task, message: `Unknown model "${id}"` });
        }
      }
      return errors;
    }),
  };
});

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  invalidateSettingsCache: vi.fn(),
  getDefaultModelForTask: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { invalidateSettingsCache } from '@/lib/orchestration/llm/settings-resolver';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-11T00:00:00.000Z');

function makeSettingsRow(
  overrides: Partial<{
    defaultModels: unknown;
    globalMonthlyBudgetUsd: number | null;
    searchConfig: unknown;
    lastSeededAt: Date | null;
    defaultApprovalTimeoutMs: number | null;
    approvalDefaultAction: string | null;
    inputGuardMode: string | null;
  }> = {}
) {
  return {
    id: 'cmjbv4i3x00003wsloputgwu1',
    slug: 'global',
    defaultModels: {
      routing: 'claude-haiku-4-5',
      chat: 'claude-sonnet-4-6',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    },
    globalMonthlyBudgetUsd: null as number | null,
    searchConfig: null as unknown,
    lastSeededAt: null as Date | null,
    defaultApprovalTimeoutMs: null as number | null,
    approvalDefaultAction: 'deny' as string | null,
    inputGuardMode: 'log_only' as string | null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeGet(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/settings');
}

function makePatch(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Admin Orchestration — /settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: true,
      limit: 100,
      remaining: 99,
      reset: Date.now() + 60_000,
    });
  });

  describe('GET — Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const res = await GET(makeGet());
      expect(res.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const res = await GET(makeGet());
      expect(res.status).toBe(403);
    });
  });

  describe('GET — Successful response', () => {
    it('upserts on first call and returns hydrated settings', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow() as never
      );

      const res = await GET(makeGet());

      expect(res.status).toBe(200);
      expect(prisma.aiOrchestrationSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: 'global' } })
      );
      const body = await parseJson<{
        success: boolean;
        data: {
          slug: string;
          defaultModels: Record<string, string>;
          globalMonthlyBudgetUsd: number | null;
          searchConfig: unknown;
          lastSeededAt: string | null;
        };
      }>(res);
      expect(body.success).toBe(true);
      expect(body.data.slug).toBe('global');
      expect(body.data.defaultModels.chat).toBe('claude-sonnet-4-6');
      expect(body.data.globalMonthlyBudgetUsd).toBeNull();
      expect(body.data.searchConfig).toBeNull();
      expect(body.data.lastSeededAt).toBeNull();
    });

    it('fills missing task keys from computed defaults', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ defaultModels: { chat: 'claude-sonnet-4-6' } }) as never
      );

      const res = await GET(makeGet());
      const body = await parseJson<{ data: { defaultModels: Record<string, string> } }>(res);

      // routing/reasoning/embeddings filled from computeDefaultModelMap mock
      expect(body.data.defaultModels.routing).toBe('claude-haiku-4-5');
      expect(body.data.defaultModels.reasoning).toBe('claude-opus-4-6');
      expect(body.data.defaultModels.embeddings).toBe('claude-haiku-4-5');
      // Stored key wins
      expect(body.data.defaultModels.chat).toBe('claude-sonnet-4-6');
    });
  });

  describe('GET — Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 100,
        remaining: 0,
        reset: Date.now() + 60_000,
      });

      const res = await GET(makeGet());

      expect(res.status).toBe(429);
      // Upsert must NOT fire when rate-limited
      expect(prisma.aiOrchestrationSettings.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET — Malformed stored defaultModels', () => {
    // Exercises parseStoredDefaults() fail branch: whatever the stored JSON
    // is (string, array, null, nested object with non-string values), it
    // must safely collapse to {} and the response must fall back to the
    // computed registry defaults.
    it.each([
      ['string', 'not-an-object'],
      ['array', ['claude-haiku-4-5']],
      ['null', null],
      ['nested non-string values', { chat: 42, routing: { id: 'x' } }],
    ])('collapses %s stored defaultModels to registry defaults', async (_label, stored) => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ defaultModels: stored as never }) as never
      );

      const res = await GET(makeGet());

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { defaultModels: Record<string, string> } }>(res);
      // All four task keys fall back to the computeDefaultModelMap mock
      expect(body.data.defaultModels).toEqual({
        routing: 'claude-haiku-4-5',
        chat: 'claude-haiku-4-5',
        reasoning: 'claude-opus-4-6',
        embeddings: 'claude-haiku-4-5',
      });
    });
  });

  describe('PATCH — Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const res = await PATCH(makePatch({ globalMonthlyBudgetUsd: 50 }));
      expect(res.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const res = await PATCH(makePatch({ globalMonthlyBudgetUsd: 50 }));
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH — Happy path', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
    });

    it('updates globalMonthlyBudgetUsd and invalidates cache', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ globalMonthlyBudgetUsd: 500 }) as never
      );

      const res = await PATCH(makePatch({ globalMonthlyBudgetUsd: 500 }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { globalMonthlyBudgetUsd: number | null } }>(res);
      expect(body.data.globalMonthlyBudgetUsd).toBe(500);
      expect(vi.mocked(invalidateSettingsCache)).toHaveBeenCalledOnce();
    });

    it('clears the global cap when set to null', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ globalMonthlyBudgetUsd: null }) as never
      );

      const res = await PATCH(makePatch({ globalMonthlyBudgetUsd: null }));
      expect(res.status).toBe(200);
    });

    it('updates defaultModels with a full map (routing key changed)', async () => {
      // Note: z.record(z.enum(TASK_TYPES), ...) requires ALL 4 task keys to be present.
      // The route merges the incoming full map with the existing row on the server side,
      // so a "partial update" from the client perspective means sending all keys but
      // changing only one value — which is what this test verifies.
      //
      // The validateTaskDefaults mock accepts any model id except 'not-a-real-model',
      // so 'claude-opus-4-6' and 'claude-haiku-4-5' both pass validation.
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({
          defaultModels: {
            routing: 'claude-opus-4-6',
            chat: 'claude-sonnet-4-6',
            reasoning: 'claude-opus-4-6',
            embeddings: 'claude-haiku-4-5',
          },
        }) as never
      );

      const res = await PATCH(
        makePatch({
          defaultModels: {
            routing: 'claude-opus-4-6', // changed
            chat: 'claude-sonnet-4-6',
            reasoning: 'claude-opus-4-6',
            embeddings: 'claude-haiku-4-5',
          },
        })
      );

      // Assert: 200 because all model ids are accepted by the validateTaskDefaults mock
      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { defaultModels: Record<string, string> } }>(res);
      expect(body.data.defaultModels.routing).toBe('claude-opus-4-6');
      expect(vi.mocked(invalidateSettingsCache)).toHaveBeenCalledOnce();
    });

    it('updates searchConfig and invalidates cache', async () => {
      const config = { keywordBoostWeight: -0.05, vectorWeight: 1.2 };
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ searchConfig: config }) as never
      );

      const res = await PATCH(makePatch({ searchConfig: config }));

      expect(res.status).toBe(200);
      const body = await parseJson<{
        data: { searchConfig: { keywordBoostWeight: number; vectorWeight: number } | null };
      }>(res);
      expect(body.data.searchConfig).toEqual(config);
      expect(vi.mocked(invalidateSettingsCache)).toHaveBeenCalledOnce();
    });

    it('updates defaultApprovalTimeoutMs', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ defaultApprovalTimeoutMs: 30_000 }) as never
      );

      const res = await PATCH(makePatch({ defaultApprovalTimeoutMs: 30_000 }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { defaultApprovalTimeoutMs: number | null } }>(res);
      expect(body.data.defaultApprovalTimeoutMs).toBe(30_000);
      expect(vi.mocked(invalidateSettingsCache)).toHaveBeenCalledOnce();
    });

    it('updates approvalDefaultAction to allow', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ approvalDefaultAction: 'allow' }) as never
      );

      const res = await PATCH(makePatch({ approvalDefaultAction: 'allow' }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { approvalDefaultAction: string | null } }>(res);
      expect(body.data.approvalDefaultAction).toBe('allow');
    });

    it('updates inputGuardMode to block', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ inputGuardMode: 'block' }) as never
      );

      const res = await PATCH(makePatch({ inputGuardMode: 'block' }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { inputGuardMode: string } }>(res);
      expect(body.data.inputGuardMode).toBe('block');
    });

    it('updates inputGuardMode to warn_and_continue', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ inputGuardMode: 'warn_and_continue' }) as never
      );

      const res = await PATCH(makePatch({ inputGuardMode: 'warn_and_continue' }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { inputGuardMode: string } }>(res);
      expect(body.data.inputGuardMode).toBe('warn_and_continue');
    });

    it('clears searchConfig when set to null', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ searchConfig: null }) as never
      );

      const res = await PATCH(makePatch({ searchConfig: null }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { searchConfig: unknown } }>(res);
      expect(body.data.searchConfig).toBeNull();
    });
  });

  describe('PATCH — Validation errors', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('rejects unknown model id (400)', async () => {
      const res = await PATCH(makePatch({ defaultModels: { chat: 'not-a-real-model' } }));
      expect(res.status).toBe(400);
    });

    it('rejects negative budget (400)', async () => {
      const res = await PATCH(makePatch({ globalMonthlyBudgetUsd: -1 }));
      expect(res.status).toBe(400);
    });

    it('rejects positive keywordBoostWeight (400)', async () => {
      const res = await PATCH(
        makePatch({ searchConfig: { keywordBoostWeight: 0.5, vectorWeight: 1.0 } })
      );
      expect(res.status).toBe(400);
    });

    it('rejects vectorWeight above max (400)', async () => {
      const res = await PATCH(
        makePatch({ searchConfig: { keywordBoostWeight: -0.02, vectorWeight: 5.0 } })
      );
      expect(res.status).toBe(400);
    });

    it('rejects empty payload (400)', async () => {
      const res = await PATCH(makePatch({}));
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH — Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 100,
        remaining: 0,
        reset: Date.now() + 60_000,
      });

      const res = await PATCH(makePatch({ globalMonthlyBudgetUsd: 50 }));

      expect(res.status).toBe(429);
    });
  });
});
