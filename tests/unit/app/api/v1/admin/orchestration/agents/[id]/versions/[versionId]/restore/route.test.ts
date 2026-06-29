/**
 * Tests: Admin Orchestration — Restore Agent Version
 *
 * POST /api/v1/admin/orchestration/agents/:id/versions/:versionId/restore
 *
 * Restores an agent to a previous version snapshot. Applies snapshot fields
 * to the agent and creates a new version entry recording the restore action.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findUnique: vi.fn(),
    },
    aiAgentVersion: {
      findFirst: vi.fn(),
    },
    // Used to drop grants that reference tags/documents deleted since the
    // snapshot was taken (so a stale id can't FK-fail the restore).
    knowledgeTag: {
      findMany: vi.fn(),
    },
    aiKnowledgeDocument: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  invalidateAgentAccess: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { invalidateAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { POST } from '@/app/api/v1/admin/orchestration/agents/[id]/versions/[versionId]/restore/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const VERSION_ID = 'cmjbv4i3x00004wsloputgwu3';

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    systemInstructions: 'current instructions',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    fallbackProviders: [],
    temperature: 0.7,
    maxTokens: 4096,
    topicBoundaries: [],
    brandVoiceInstructions: null,
    metadata: null,
    knowledgeCategories: [],
    rateLimitRpm: null,
    visibility: 'internal',
    ...overrides,
  };
}

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    agentId: AGENT_ID,
    version: 2,
    snapshot: {
      systemInstructions: 'old instructions',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      fallbackProviders: [],
      temperature: 0.7,
      maxTokens: 4096,
      topicBoundaries: [],
      brandVoiceInstructions: null,
      metadata: null,
      knowledgeCategories: [],
      rateLimitRpm: null,
      visibility: 'internal',
    },
    changeSummary: 'systemInstructions changed',
    createdBy: 'admin-1',
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(agentId: string, versionId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${agentId}/versions/${versionId}/restore`,
    { method: 'POST' }
  );
}

function makeParams(id: string, versionId: string) {
  return { params: Promise.resolve({ id, versionId }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /agents/:id/versions/:versionId/restore', () => {
  // ── Authentication ─────────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    // Assert
    expect(response.status).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ── Rate limiting ──────────────────────────────────────────────────

  // ── Validation ─────────────────────────────────────────────────────

  it('returns 400 for invalid agent CUID', async () => {
    // Arrange: non-CUID agent id
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Act
    const response = await POST(
      makeRequest('bad-agent-id', VERSION_ID),
      makeParams('bad-agent-id', VERSION_ID)
    );

    // Assert
    expect(response.status).toBe(400);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid version CUID', async () => {
    // Arrange: non-CUID version id
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, 'not-a-cuid'),
      makeParams(AGENT_ID, 'not-a-cuid')
    );

    // Assert
    expect(response.status).toBe(400);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── System agent protection ────────────────────────────────────────

  it('restores a system agent but skips the protected fields (slug, systemInstructions, isActive)', async () => {
    // System agents are restorable now (#330), but the fields the PATCH route
    // guards as read-only must NOT be reverted by a restore — only the rest of
    // the config is. A green-bar version would let the snapshot's slug/
    // instructions/active state through; this proves they're held back while a
    // non-protected field (model) IS restored.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
      makeAgent({
        isSystem: true,
        slug: 'sys-current',
        systemInstructions: 'current instructions',
        isActive: true,
      }) as never
    );
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(
      makeVersion({
        snapshot: {
          slug: 'sys-old',
          systemInstructions: 'old instructions',
          isActive: false,
          model: 'claude-opus-4-8',
          temperature: 0.2,
          provider: 'anthropic',
        },
      })
    );
    const txAgentUpdate = vi.fn().mockResolvedValue(makeAgent({ isSystem: true }));
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
      const tx = {
        aiAgent: { update: txAgentUpdate },
        aiAgentVersion: {
          findFirst: vi.fn().mockResolvedValue({ version: 2 }),
          create: vi.fn().mockResolvedValue({}),
        },
        aiAgentKnowledgeTag: { deleteMany: vi.fn(), createMany: vi.fn() },
        aiAgentKnowledgeDocument: { deleteMany: vi.fn(), createMany: vi.fn() },
      };
      return callback(tx as never);
    });

    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    expect(response.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalled();
    const data = (txAgentUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    // Protected system fields are NOT reverted by the restore…
    expect(data).not.toHaveProperty('slug');
    expect(data).not.toHaveProperty('systemInstructions');
    expect(data).not.toHaveProperty('systemInstructionsHistory');
    expect(data).not.toHaveProperty('isActive');
    // …but the rest of the config IS restored.
    expect(data.model).toBe('claude-opus-4-8');
    expect(data.temperature).toBe(0.2);
  });

  // ── Not found ──────────────────────────────────────────────────────

  it('returns 404 when agent does not exist', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    // Assert
    expect(response.status).toBe(404);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    // Transaction must not be called when agent is missing
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 404 when version does not exist for the given agent', async () => {
    // Arrange: agent exists but version does not (or belongs to different agent)
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(null);

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    // Assert
    expect(response.status).toBe(404);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ── Snapshot validation ────────────────────────────────────────────

  it('returns 400 when version snapshot contains invalid data', async () => {
    // Arrange: snapshot has a field that fails the versionSnapshotSchema
    // (e.g. visibility is not one of the allowed enum values)
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(
      makeVersion({
        snapshot: { visibility: 'not_a_valid_enum_value' },
      })
    );

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    // Assert
    expect(response.status).toBe(400);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ── Happy path ─────────────────────────────────────────────────────

  it('restores agent and returns correct response envelope', async () => {
    // Arrange
    const updatedAgent = makeAgent({ systemInstructions: 'old instructions' });
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(makeVersion());
    // The transaction callback is invoked with a tx client; mock it to
    // return the {updated, nextVersion} shape that the handler destructures.
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
      const tx = {
        aiAgent: {
          update: vi.fn().mockResolvedValue(updatedAgent),
        },
        aiAgentVersion: {
          findFirst: vi.fn().mockResolvedValue({ version: 2 }),
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return callback(tx as never);
    });

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    // Assert — route wraps result in { success, data: { agent, restoredFromVersion, newVersion } }
    expect(response.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: { agent: Record<string, unknown>; restoredFromVersion: number; newVersion: number };
    }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.agent).toMatchObject({ id: AGENT_ID });
    // version was 2, nextVersion = 2 + 1 = 3
    expect(body.data.restoredFromVersion).toBe(2);
    expect(body.data.newVersion).toBe(3);
  });

  it('invokes transaction with update + create calls against the right agent', async () => {
    // Arrange: verify the transaction performs the correct DB operations
    const version = makeVersion();
    const updatedAgent = makeAgent();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(version);

    const txAgentUpdate = vi.fn().mockResolvedValue(updatedAgent);
    const txVersionFindFirst = vi.fn().mockResolvedValue({ version: 5 });
    const txVersionCreate = vi.fn().mockResolvedValue({});
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
      const tx = {
        aiAgent: { update: txAgentUpdate },
        aiAgentVersion: { findFirst: txVersionFindFirst, create: txVersionCreate },
      };
      return callback(tx as never);
    });

    // Act
    await POST(makeRequest(AGENT_ID, VERSION_ID), makeParams(AGENT_ID, VERSION_ID));

    // Assert — the transaction executed the right DB calls
    expect(txAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: AGENT_ID } })
    );
    expect(txVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: AGENT_ID,
          changeSummary: `Restored from version ${version.version}`,
        }),
      })
    );
    expect(txVersionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agentId: AGENT_ID }, orderBy: { version: 'desc' } })
    );
  });

  it('coerces null JSON columns to Prisma.JsonNull and restores knowledgeAccessMode', async () => {
    // metadata/providerConfig are nullable Json columns — Prisma rejects a
    // literal null on write, so restore must coerce to Prisma.JsonNull (as the
    // create/clone/import paths do). knowledgeAccessMode is now restored too:
    // #330 reapplies it alongside the knowledge grants + a cache invalidation
    // (it was deferred in #333 only because grants weren't yet reapplied).
    const snapshot = {
      systemInstructions: 'x',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      metadata: null,
      providerConfig: null,
      knowledgeAccessMode: 'restricted',
      knowledgeRetrievalMode: 'every_turn',
    };
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(makeVersion({ snapshot }));
    const txAgentUpdate = vi.fn().mockResolvedValue(makeAgent());
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
      const tx = {
        aiAgent: { update: txAgentUpdate },
        aiAgentVersion: {
          findFirst: vi.fn().mockResolvedValue({ version: 1 }),
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return callback(tx as never);
    });

    await POST(makeRequest(AGENT_ID, VERSION_ID), makeParams(AGENT_ID, VERSION_ID));

    const data = (txAgentUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.metadata).toBe(Prisma.JsonNull);
    expect(data.providerConfig).toBe(Prisma.JsonNull);
    expect(data.knowledgeAccessMode).toBe('restricted');
    expect(data.knowledgeRetrievalMode).toBe('every_turn');
  });

  it('restores knowledge grants from the snapshot, dropping ids deleted since, and invalidates the cache', async () => {
    // The snapshot grants two tags and one document; one tag was deleted since,
    // so it must be filtered out (a stale id would FK-fail the restore). The
    // surviving grants are written and the access-resolver cache is evicted.
    // Grant ids must be valid CUIDs — the snapshot is validated against the same
    // per-field schema a PATCH uses.
    const TAG_KEEP = 'cmjbv4i3x00003wsloputgta1';
    const TAG_GONE = 'cmjbv4i3x00003wsloputgta2';
    const DOC_KEEP = 'cmjbv4i3x00003wsloputgdo1';
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
      makeAgent({
        grantedTags: [{ tagId: 'cmjbv4i3x00003wsloputgta9' }],
        grantedDocuments: [],
      }) as never
    );
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(
      makeVersion({
        snapshot: {
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          grantedTagIds: [TAG_KEEP, TAG_GONE],
          grantedDocumentIds: [DOC_KEEP],
        },
      })
    );
    // TAG_GONE no longer exists; DOC_KEEP does.
    vi.mocked(prisma.knowledgeTag.findMany).mockResolvedValue([{ id: TAG_KEEP }] as never);
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([{ id: DOC_KEEP }] as never);

    const txTagDelete = vi.fn();
    const txTagCreate = vi.fn();
    const txDocDelete = vi.fn();
    const txDocCreate = vi.fn();
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
      const tx = {
        aiAgent: { update: vi.fn().mockResolvedValue(makeAgent()) },
        aiAgentVersion: {
          findFirst: vi.fn().mockResolvedValue({ version: 2 }),
          create: vi.fn().mockResolvedValue({}),
        },
        aiAgentKnowledgeTag: { deleteMany: txTagDelete, createMany: txTagCreate },
        aiAgentKnowledgeDocument: { deleteMany: txDocDelete, createMany: txDocCreate },
      };
      return callback(tx as never);
    });

    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    expect(response.status).toBe(200);
    // TAG_GONE filtered out; only TAG_KEEP written.
    expect(txTagDelete).toHaveBeenCalledWith({ where: { agentId: AGENT_ID } });
    expect(txTagCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ agentId: AGENT_ID, tagId: TAG_KEEP }] })
    );
    expect(txDocCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ agentId: AGENT_ID, documentId: DOC_KEEP }] })
    );
    // Cache eviction so the next chat turn sees the restored access.
    expect(vi.mocked(invalidateAgentAccess)).toHaveBeenCalledWith(AGENT_ID);
  });

  it('uses nextVersion = 1 when no prior versions exist in the transaction', async () => {
    // Arrange: lastVersion query returns null — (null?.version ?? 0) + 1 = 1
    const updatedAgent = makeAgent();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(makeVersion());
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
      const tx = {
        aiAgent: { update: vi.fn().mockResolvedValue(updatedAgent) },
        aiAgentVersion: {
          findFirst: vi.fn().mockResolvedValue(null), // no prior versions
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return callback(tx as never);
    });

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    // Assert
    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { newVersion: number } }>(response);
    expect(body.data.newVersion).toBe(1);
  });

  it('returns 500 when the Prisma transaction throws', async () => {
    // Arrange: transaction fails mid-execution (DB error, constraint, etc.)
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(makeVersion());
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('Transaction failed'));

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    // Assert — unhandled DB errors surface as 500
    expect(response.status).toBe(500);
    const body = await parseJson<{ success: boolean }>(response);
    expect(body.success).toBe(false);
  });

  it('applies only snapshot fields that are present — skips undefined fields', async () => {
    // Arrange: sparse snapshot — only systemInstructions is set; all other fields are
    // undefined (absent from snapshot). The handler must not set those fields on updateData.
    const sparseSnapshot = { systemInstructions: 'sparse instructions' };
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(
      makeVersion({ snapshot: sparseSnapshot })
    );

    const txAgentUpdate = vi.fn().mockResolvedValue(makeAgent());
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
      const tx = {
        aiAgent: { update: txAgentUpdate },
        aiAgentVersion: {
          findFirst: vi.fn().mockResolvedValue({ version: 1 }),
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return callback(tx as never);
    });

    // Act
    await POST(makeRequest(AGENT_ID, VERSION_ID), makeParams(AGENT_ID, VERSION_ID));

    // Assert — updateData only contains systemInstructions, not model/provider/etc.
    expect(txAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ systemInstructions: 'sparse instructions' }),
      })
    );
    const callArgs = txAgentUpdate.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(callArgs[0].data).not.toHaveProperty('model');
    expect(callArgs[0].data).not.toHaveProperty('provider');
    expect(callArgs[0].data).not.toHaveProperty('temperature');
  });

  it('restores expanded snapshot fields (guard modes, budget, history tokens)', async () => {
    const fullSnapshot = {
      systemInstructions: 'old',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputGuardMode: 'block',
      outputGuardMode: 'warn_and_continue',
      maxHistoryTokens: 8000,
      retentionDays: 30,
      providerConfig: { timeout: 5000 },
      monthlyBudgetUsd: 100,
    };
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(
      makeVersion({ snapshot: fullSnapshot })
    );

    const txAgentUpdate = vi.fn().mockResolvedValue(makeAgent());
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
      const tx = {
        aiAgent: { update: txAgentUpdate },
        aiAgentVersion: {
          findFirst: vi.fn().mockResolvedValue({ version: 1 }),
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return callback(tx as never);
    });

    await POST(makeRequest(AGENT_ID, VERSION_ID), makeParams(AGENT_ID, VERSION_ID));

    const callArgs = txAgentUpdate.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(callArgs[0].data).toHaveProperty('inputGuardMode', 'block');
    expect(callArgs[0].data).toHaveProperty('outputGuardMode', 'warn_and_continue');
    expect(callArgs[0].data).toHaveProperty('maxHistoryTokens', 8000);
    expect(callArgs[0].data).toHaveProperty('retentionDays', 30);
    expect(callArgs[0].data).toHaveProperty('monthlyBudgetUsd', 100);
  });

  it('rejects a snapshot with null in a non-nullable column (temperature/maxTokens)', async () => {
    // The snapshot is validated against the same per-field rules a PATCH uses
    // (updateAgentObjectSchema). temperature/maxTokens are non-nullable there, so
    // a null — which can only come from a corrupt/synthetic snapshot, never the
    // snapshot writer — is a clean 400 rather than a silent partial restore.
    const snapshotWithNulls = {
      systemInstructions: 'test',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      temperature: null,
      maxTokens: null,
    };
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(
      makeVersion({ snapshot: snapshotWithNulls })
    );

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    // Assert — rejected before any write
    expect(response.status).toBe(400);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
