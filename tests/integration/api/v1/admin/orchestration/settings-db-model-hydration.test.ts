/**
 * Regression: PATCH /settings accepts DB-managed (discovery-added) model ids
 *
 * Bug A of issue #302 — a date-stamped model (e.g. `gpt-5.5-pro-2026-04-23`)
 * that lives only in the `AiProviderModel` matrix (added via discovery, absent
 * from the static registry and OpenRouter cache) was offered in the settings
 * dropdown but rejected on save with `VALIDATION_ERROR` (400). Root cause: the
 * PATCH handler ran `validateRequestBody` (whose `defaultModels` refinement
 * calls the synchronous `getModel()`) WITHOUT first hydrating the registry from
 * the DB. The fix `await hydrateFromDb()` before validating.
 *
 * Unlike the broad settings.test.ts, this file deliberately uses the REAL
 * model-registry, REAL hydrateFromDb, and REAL db-model-adapter — mocking any
 * of them would mask the very bug under test. Only the DB, auth, and unrelated
 * side-effect modules are mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { mockAdminUser } from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiOrchestrationSettings: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(),
    },
    aiProviderModel: {
      // The matrix the registry hydrates from. Overridden per test.
      findMany: vi.fn(async () => []),
    },
  },
}));

// Side-effect-only collaborators — mocked to keep the test hermetic.
vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  invalidateSettingsCache: vi.fn(),
  getDefaultModelForTask: vi.fn(),
}));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => ({})),
}));

// NOT mocked (the point of this test): model-registry, model-registry-db-hydrate,
// db-model-adapter, lib/orchestration/settings.

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { PATCH } from '@/app/api/v1/admin/orchestration/settings/route';
import { __resetForTests as resetRegistry } from '@/lib/orchestration/llm/model-registry';
import { __resetForTests as resetHydrateThrottle } from '@/lib/orchestration/llm/model-registry-db-hydrate';

const DATE_STAMPED_ID = 'gpt-5.5-pro-2026-04-23';

/** A full `AiProviderModel` row as `hydrateFromDb` → `findMany` would return. */
function makeMatrixRow(modelId: string) {
  return {
    id: 'cm_model_datestamped_001',
    providerSlug: 'openai',
    modelId,
    name: modelId,
    isActive: true,
    capabilities: ['chat', 'reasoning'],
    tierRole: 'thinking',
    deploymentProfiles: ['hosted'],
    contextLength: 'high',
    toolUse: 'strong',
    costPerMillionTokens: null,
    paramProfile: 'openai-reasoning',
  };
}

/** A complete settings row for the `upsert` return so `hydrateSettings` is happy. */
function makeSettingsRow() {
  const now = new Date('2026-06-24T00:00:00.000Z');
  return {
    id: 'cm_settings_global',
    slug: 'global',
    defaultModels: { chat: DATE_STAMPED_ID },
    globalMonthlyBudgetUsd: null,
    searchConfig: null,
    lastSeededAt: null,
    defaultApprovalTimeoutMs: null,
    approvalDefaultAction: 'deny',
    inputGuardMode: 'log_only',
    outputGuardMode: 'log_only',
    citationGuardMode: 'log_only',
    webhookRetentionDays: null,
    costLogRetentionDays: null,
    auditLogRetentionDays: null,
    executionRetentionDays: null,
    evaluationRetentionDays: null,
    maxConversationsPerUser: null,
    maxMessagesPerConversation: null,
    escalationConfig: null,
    embedAllowedOrigins: [],
    voiceInputGloballyEnabled: true,
    imageInputGloballyEnabled: false,
    documentInputGloballyEnabled: false,
    activeEmbeddingModelId: null,
    stuckExecutionThresholdMins: null,
    defaultMaxCostPerExecutionUsd: null,
    defaultMaxCostPerTurnUsd: null,
    createdAt: now,
    updatedAt: now,
  };
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

describe('PATCH /settings — DB-managed model hydration (issue #302, Bug A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRegistry();
    resetHydrateThrottle();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(makeSettingsRow() as never);
  });

  it('accepts a date-stamped model that exists only in the DB matrix (200)', async () => {
    // The model is in the matrix (dropdown source) but not the static registry.
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
      makeMatrixRow(DATE_STAMPED_ID),
    ] as never);

    const res = await PATCH(makePatch({ defaultModels: { chat: DATE_STAMPED_ID } }));

    expect(res.status).toBe(200);
    // The selection actually persisted — proves it passed validation AND merge,
    // not merely that some 200 was returned.
    const upsertArg = vi.mocked(prisma.aiOrchestrationSettings.upsert).mock.calls[0][0];
    expect((upsertArg.update.defaultModels as Record<string, string>).chat).toBe(DATE_STAMPED_ID);
  });

  it('still rejects the same id when no matching DB row exists (400)', async () => {
    // Negative control: with an empty matrix the id is genuinely unknown, so
    // the registry hydration legitimately can't vouch for it. This proves the
    // 200 above is earned by the DB row, not by hydration blanket-accepting.
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);

    const res = await PATCH(makePatch({ defaultModels: { chat: DATE_STAMPED_ID } }));

    expect(res.status).toBe(400);
    const json = await parseJson<{ error: { code: string } }>(res);
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });
});
