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
    aiProviderModel: {
      // Audio default validation: PATCH checks the chosen modelId
      // exists in the matrix with capabilities including 'audio'.
      // Default: every audio-shaped id matches; specific tests
      // override per case.
      findFirst: vi.fn(async () => ({ id: 'cm_audio_001' })),
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
      // Computed audio default is intentionally empty — audio support
      // is matrix-driven, the operator picks from active rows with
      // capabilities:['audio']. Mocking it as '' mirrors production.
      audio: '',
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

vi.mock('@/lib/orchestration/llm/embedding-models', () => ({
  // Minimal fixture shaped like EmbeddingModelInfo — only `model` is read.
  // Tests that exercise the embeddings-validation guard override this in
  // their own `beforeEach` if they need a different set.
  getEmbeddingModels: vi.fn(async () => [
    { model: 'text-embedding-3-small' },
    { model: 'voyage-3' },
    { model: 'nomic-embed-text' },
  ]),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
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
    outputGuardMode: string | null;
    citationGuardMode: string | null;
    webhookRetentionDays: number | null;
    costLogRetentionDays: number | null;
    auditLogRetentionDays: number | null;
    maxConversationsPerUser: number | null;
    maxMessagesPerConversation: number | null;
    embedAllowedOrigins: unknown;
    voiceInputGloballyEnabled: boolean;
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
    outputGuardMode: 'log_only' as string | null,
    citationGuardMode: 'log_only' as string | null,
    webhookRetentionDays: null as number | null,
    costLogRetentionDays: null as number | null,
    auditLogRetentionDays: null as number | null,
    maxConversationsPerUser: null as number | null,
    maxMessagesPerConversation: null as number | null,
    voiceInputGloballyEnabled: true as boolean,
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // All five task keys fall back to the computeDefaultModelMap mock.
      // `audio` is intentionally '' — matrix-driven, no registry suggestion.
      expect(body.data.defaultModels).toEqual({
        routing: 'claude-haiku-4-5',
        chat: 'claude-haiku-4-5',
        reasoning: 'claude-opus-4-6',
        embeddings: 'claude-haiku-4-5',
        audio: '',
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
      // The validateTaskDefaults mock accepts any model id except 'not-a-real-model'.
      // The embeddings slot is also re-validated by the route against the
      // DB-backed embedding-model registry (mocked above), so we use a real
      // embedding id here.
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({
          defaultModels: {
            routing: 'claude-opus-4-6',
            chat: 'claude-sonnet-4-6',
            reasoning: 'claude-opus-4-6',
            embeddings: 'text-embedding-3-small',
          },
        }) as never
      );

      const res = await PATCH(
        makePatch({
          defaultModels: {
            routing: 'claude-opus-4-6', // changed
            chat: 'claude-sonnet-4-6',
            reasoning: 'claude-opus-4-6',
            embeddings: 'text-embedding-3-small',
          },
        })
      );

      // Assert: 200 because all model ids are accepted by the validateTaskDefaults
      // mock and the embeddings id is in the embedding-models mock fixture.
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

    it('updates voiceInputGloballyEnabled to false (org-wide kill switch)', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ voiceInputGloballyEnabled: false }) as never
      );

      const res = await PATCH(makePatch({ voiceInputGloballyEnabled: false }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { voiceInputGloballyEnabled: boolean } }>(res);
      expect(body.data.voiceInputGloballyEnabled).toBe(false);

      const upsertCall = vi.mocked(prisma.aiOrchestrationSettings.upsert).mock.calls[0]?.[0];
      expect(upsertCall?.update.voiceInputGloballyEnabled).toBe(false);
      expect(vi.mocked(invalidateSettingsCache)).toHaveBeenCalledOnce();
    });

    it('updates voiceInputGloballyEnabled back to true', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ voiceInputGloballyEnabled: true }) as never
      );

      const res = await PATCH(makePatch({ voiceInputGloballyEnabled: true }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { voiceInputGloballyEnabled: boolean } }>(res);
      expect(body.data.voiceInputGloballyEnabled).toBe(true);

      const upsertCall = vi.mocked(prisma.aiOrchestrationSettings.upsert).mock.calls[0]?.[0];
      expect(upsertCall?.update.voiceInputGloballyEnabled).toBe(true);
    });

    it('rejects non-boolean voiceInputGloballyEnabled (400)', async () => {
      const res = await PATCH(makePatch({ voiceInputGloballyEnabled: 'yes' }));
      expect(res.status).toBe(400);
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

    it('updates outputGuardMode to block', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ outputGuardMode: 'block' }) as never
      );

      const res = await PATCH(makePatch({ outputGuardMode: 'block' }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { outputGuardMode: string } }>(res);
      expect(body.data.outputGuardMode).toBe('block');
    });

    it('updates webhookRetentionDays', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ webhookRetentionDays: 30 }) as never
      );

      const res = await PATCH(makePatch({ webhookRetentionDays: 30 }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { webhookRetentionDays: number | null } }>(res);
      expect(body.data.webhookRetentionDays).toBe(30);
    });

    it('updates costLogRetentionDays', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ costLogRetentionDays: 90 }) as never
      );

      const res = await PATCH(makePatch({ costLogRetentionDays: 90 }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { costLogRetentionDays: number | null } }>(res);
      expect(body.data.costLogRetentionDays).toBe(90);
    });

    it('updates auditLogRetentionDays', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ auditLogRetentionDays: 365 }) as never
      );

      const res = await PATCH(makePatch({ auditLogRetentionDays: 365 }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { auditLogRetentionDays: number | null } }>(res);
      expect(body.data.auditLogRetentionDays).toBe(365);
    });

    it('rejects auditLogRetentionDays above 3650 (400)', async () => {
      const res = await PATCH(makePatch({ auditLogRetentionDays: 3651 }));
      expect(res.status).toBe(400);
    });

    it('updates maxConversationsPerUser', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ maxConversationsPerUser: 50 }) as never
      );

      const res = await PATCH(makePatch({ maxConversationsPerUser: 50 }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { maxConversationsPerUser: number | null } }>(res);
      expect(body.data.maxConversationsPerUser).toBe(50);
    });

    it('updates maxMessagesPerConversation', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ maxMessagesPerConversation: 200 }) as never
      );

      const res = await PATCH(makePatch({ maxMessagesPerConversation: 200 }));

      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { maxMessagesPerConversation: number | null } }>(res);
      expect(body.data.maxMessagesPerConversation).toBe(200);
    });

    it('clears retention days when set to null', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ webhookRetentionDays: null, costLogRetentionDays: null }) as never
      );

      const res = await PATCH(
        makePatch({ webhookRetentionDays: null, costLogRetentionDays: null })
      );

      expect(res.status).toBe(200);
      const body = await parseJson<{
        data: { webhookRetentionDays: number | null; costLogRetentionDays: number | null };
      }>(res);
      expect(body.data.webhookRetentionDays).toBeNull();
      expect(body.data.costLogRetentionDays).toBeNull();
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

    it('rejects negative retention days (400)', async () => {
      const res = await PATCH(makePatch({ webhookRetentionDays: -1 }));
      expect(res.status).toBe(400);
    });

    it('rejects retention days above 365 (400)', async () => {
      const res = await PATCH(makePatch({ costLogRetentionDays: 400 }));
      expect(res.status).toBe(400);
    });

    it('rejects negative maxConversationsPerUser (400)', async () => {
      const res = await PATCH(makePatch({ maxConversationsPerUser: -5 }));
      expect(res.status).toBe(400);
    });

    it('rejects maxMessagesPerConversation above 10000 (400)', async () => {
      const res = await PATCH(makePatch({ maxMessagesPerConversation: 99999 }));
      expect(res.status).toBe(400);
    });

    it('rejects empty payload (400)', async () => {
      const res = await PATCH(makePatch({}));
      expect(res.status).toBe(400);
    });

    it('rejects http://attacker.com in embedAllowedOrigins (400)', async () => {
      const res = await PATCH(makePatch({ embedAllowedOrigins: ['http://attacker.com'] }));
      expect(res.status).toBe(400);
    });

    it('rejects malformed URL in embedAllowedOrigins (400)', async () => {
      const res = await PATCH(makePatch({ embedAllowedOrigins: ['not-a-url'] }));
      expect(res.status).toBe(400);
    });

    it('rejects more than 100 origins in embedAllowedOrigins (400)', async () => {
      const origins = Array.from({ length: 101 }, (_, i) => `https://partner${i}.com`);
      const res = await PATCH(makePatch({ embedAllowedOrigins: origins }));
      expect(res.status).toBe(400);
    });

    // Defence-in-depth: the embeddings slot bypasses the chat-registry
    // `getModel()` lookup that backs the other task slots, because the
    // embedding-model registry is DB-backed/async and Zod refinements are
    // sync. Without an explicit server check, an admin (or compromised
    // admin token) could PATCH an arbitrary string into the slot and the
    // failure would only surface at the next embed-using chat turn.
    it('rejects an unknown embedding model id (400)', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
      const res = await PATCH(
        makePatch({
          defaultModels: {
            routing: 'claude-haiku-4-5',
            chat: 'claude-haiku-4-5',
            reasoning: 'claude-opus-4-6',
            embeddings: 'gpt-4o-mini', // chat model, not an embedding model
          },
        })
      );

      expect(res.status).toBe(400);
      const body = await parseJson<{
        success: boolean;
        error: { code: string; message: string; details?: { task?: string; value?: string } };
      }>(res);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.task).toBe('embeddings');
      expect(body.error.details?.value).toBe('gpt-4o-mini');
      // Upsert must NOT have run — guard rejects before persistence.
      expect(vi.mocked(prisma.aiOrchestrationSettings.upsert)).not.toHaveBeenCalled();
    });

    it('accepts a known embedding model id from the embedding-models registry', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({
          defaultModels: {
            routing: 'claude-haiku-4-5',
            chat: 'claude-haiku-4-5',
            reasoning: 'claude-opus-4-6',
            embeddings: 'voyage-3',
          },
        }) as never
      );

      const res = await PATCH(
        makePatch({
          defaultModels: {
            routing: 'claude-haiku-4-5',
            chat: 'claude-haiku-4-5',
            reasoning: 'claude-opus-4-6',
            embeddings: 'voyage-3',
          },
        })
      );

      expect(res.status).toBe(200);
      expect(vi.mocked(prisma.aiOrchestrationSettings.upsert)).toHaveBeenCalledOnce();
    });

    it('skips the embeddings guard when no defaultModels patch is sent', async () => {
      // PATCHes that don't touch defaultModels at all must not invoke
      // the embedding-models registry — saving e.g. just a budget change
      // shouldn't pay an extra DB read or fail if that lookup is broken.
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ globalMonthlyBudgetUsd: 250 }) as never
      );
      const { getEmbeddingModels } = await import('@/lib/orchestration/llm/embedding-models');
      vi.mocked(getEmbeddingModels).mockClear();

      const res = await PATCH(makePatch({ globalMonthlyBudgetUsd: 250 }));

      expect(res.status).toBe(200);
      expect(vi.mocked(getEmbeddingModels)).not.toHaveBeenCalled();
    });

    it('accepts a partial defaultModels map with only one slot set', async () => {
      // The form filters empty slots out of the PATCH payload before
      // sending — picking only `chat` posts `{ defaultModels: { chat: '...' } }`
      // with no other keys. The schema is `z.partialRecord` so this
      // succeeds; the route merges the patch into the existing row,
      // preserving routing/reasoning/embeddings as previously stored.
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({
          defaultModels: {
            routing: 'claude-haiku-4-5',
            chat: 'claude-sonnet-4-6',
            reasoning: 'claude-opus-4-6',
            embeddings: 'claude-haiku-4-5',
          },
        }) as never
      );
      const { getEmbeddingModels } = await import('@/lib/orchestration/llm/embedding-models');
      vi.mocked(getEmbeddingModels).mockClear();

      const res = await PATCH(makePatch({ defaultModels: { chat: 'claude-sonnet-4-6' } }));

      expect(res.status).toBe(200);
      // No embeddings slot in the patch, so the registry guard is skipped.
      expect(vi.mocked(getEmbeddingModels)).not.toHaveBeenCalled();
      expect(vi.mocked(prisma.aiOrchestrationSettings.upsert)).toHaveBeenCalledOnce();
    });

    it('accepts an empty defaultModels patch (no-op merge)', async () => {
      // Edge case: form sends `{ defaultModels: {} }` if every slot was
      // emptied. Schema accepts (partialRecord), route merges nothing,
      // existing values are preserved.
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow() as never
      );

      const res = await PATCH(makePatch({ defaultModels: {} }));

      expect(res.status).toBe(200);
    });

    it('accepts a valid audio model id that exists in the matrix with capability:audio', async () => {
      // The audio guard runs a matrix existence check (unlike chat/
      // reasoning which use the in-memory registry). Mock the lookup
      // to return a row, simulating an operator who's already curated
      // a Whisper entry.
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({
          defaultModels: {
            routing: 'claude-haiku-4-5',
            chat: 'claude-haiku-4-5',
            reasoning: 'claude-opus-4-6',
            embeddings: 'claude-haiku-4-5',
            audio: 'whisper-1',
          },
        }) as never
      );
      vi.mocked(prisma.aiProviderModel.findFirst).mockResolvedValue({
        id: 'cm_audio_001',
      } as never);

      const res = await PATCH(makePatch({ defaultModels: { audio: 'whisper-1' } }));

      expect(res.status).toBe(200);
      // Sanity: the matrix lookup ran with the right where clause —
      // capabilities must include 'audio' so a misconfigured chat
      // model can't slip through.
      expect(vi.mocked(prisma.aiProviderModel.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            modelId: 'whisper-1',
            isActive: true,
            capabilities: { has: 'audio' },
          }),
        })
      );
    });

    it('rejects an audio model id with no matching matrix row', async () => {
      // Operator typo or bogus PATCH — the matrix has no row that
      // would satisfy getAudioProvider(), so the runtime would fail
      // mysteriously. Guard returns 400 instead.
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
      vi.mocked(prisma.aiProviderModel.findFirst).mockResolvedValue(null as never);

      const res = await PATCH(makePatch({ defaultModels: { audio: 'not-a-real-whisper' } }));
      const body = await parseJson<{
        success: boolean;
        error: { code: string; details?: { task?: string; value?: string } };
      }>(res);

      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.task).toBe('audio');
      expect(body.error.details?.value).toBe('not-a-real-whisper');
      // Upsert must NOT run — guard rejects before persistence.
      expect(vi.mocked(prisma.aiOrchestrationSettings.upsert)).not.toHaveBeenCalled();
    });

    it('rejects a chat-only model id submitted as the audio default', async () => {
      // The guard's `capabilities: { has: 'audio' }` filter is what
      // stops this — gpt-4o exists in the matrix but doesn't have
      // audio capability. findFirst returns null, route returns 400.
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
      vi.mocked(prisma.aiProviderModel.findFirst).mockResolvedValue(null as never);

      const res = await PATCH(makePatch({ defaultModels: { audio: 'gpt-4o' } }));
      const body = await parseJson<{ error: { details?: { task?: string } } }>(res);

      expect(res.status).toBe(400);
      expect(body.error.details?.task).toBe('audio');
    });
  });

  describe('PATCH — embedAllowedOrigins (write-side normalisation)', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow() as never
      );
    });

    it('normalises trailing slash before persistence', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ embedAllowedOrigins: ['https://partner.com'] }) as never
      );

      const res = await PATCH(makePatch({ embedAllowedOrigins: ['https://partner.com/'] }));

      expect(res.status).toBe(200);
      const upsertCall = vi.mocked(prisma.aiOrchestrationSettings.upsert).mock.calls[0]?.[0];
      expect(upsertCall?.update.embedAllowedOrigins).toEqual(['https://partner.com']);
    });

    it('strips explicit default ports before persistence', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ embedAllowedOrigins: ['https://partner.com'] }) as never
      );

      const res = await PATCH(makePatch({ embedAllowedOrigins: ['https://partner.com:443'] }));

      expect(res.status).toBe(200);
      const upsertCall = vi.mocked(prisma.aiOrchestrationSettings.upsert).mock.calls[0]?.[0];
      expect(upsertCall?.update.embedAllowedOrigins).toEqual(['https://partner.com']);
    });

    it('strips paths before persistence', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ embedAllowedOrigins: ['https://partner.com'] }) as never
      );

      const res = await PATCH(makePatch({ embedAllowedOrigins: ['https://partner.com/widget'] }));

      expect(res.status).toBe(200);
      const upsertCall = vi.mocked(prisma.aiOrchestrationSettings.upsert).mock.calls[0]?.[0];
      expect(upsertCall?.update.embedAllowedOrigins).toEqual(['https://partner.com']);
    });

    it('accepts http://localhost for development', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ embedAllowedOrigins: ['http://localhost:3000'] }) as never
      );

      const res = await PATCH(makePatch({ embedAllowedOrigins: ['http://localhost:3000'] }));

      expect(res.status).toBe(200);
    });

    it('persists empty array (clear allowlist)', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
        makeSettingsRow({ embedAllowedOrigins: [] }) as never
      );

      const res = await PATCH(makePatch({ embedAllowedOrigins: [] }));

      expect(res.status).toBe(200);
      const upsertCall = vi.mocked(prisma.aiOrchestrationSettings.upsert).mock.calls[0]?.[0];
      expect(upsertCall?.update.embedAllowedOrigins).toEqual([]);
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
