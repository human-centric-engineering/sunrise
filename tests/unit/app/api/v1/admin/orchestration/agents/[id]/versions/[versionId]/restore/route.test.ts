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
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
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
import { adminLimiter } from '@/lib/security/rate-limit';
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
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
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

  it('returns 429 when rate limited', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    // Assert
    expect(response.status).toBe(429);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

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

  it('returns 403 when restoring a system agent', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent({ isSystem: true }) as never);

    const response = await POST(
      makeRequest(AGENT_ID, VERSION_ID),
      makeParams(AGENT_ID, VERSION_ID)
    );

    expect(response.status).toBe(403);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
      }) as never
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
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(makeVersion() as never);
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
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(version as never);

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

  it('uses nextVersion = 1 when no prior versions exist in the transaction', async () => {
    // Arrange: lastVersion query returns null — (null?.version ?? 0) + 1 = 1
    const updatedAgent = makeAgent();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(makeVersion() as never);
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
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(makeVersion() as never);
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
      makeVersion({ snapshot: sparseSnapshot }) as never
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
      makeVersion({ snapshot: fullSnapshot }) as never
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

  it('omits null temperature and maxTokens from updateData (null guard)', async () => {
    // Arrange: snapshot includes temperature=null and maxTokens=null.
    // The handler has an extra `!== null` guard for these two fields, so they
    // must NOT appear in updateData even though snapshot.temperature !== undefined.
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
      makeVersion({ snapshot: snapshotWithNulls }) as never
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

    // Assert — temperature and maxTokens are NOT in updateData
    const callArgs = txAgentUpdate.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(callArgs[0].data).not.toHaveProperty('temperature');
    expect(callArgs[0].data).not.toHaveProperty('maxTokens');
    // Other fields that were set should still appear
    expect(callArgs[0].data).toHaveProperty('systemInstructions', 'test');
    expect(callArgs[0].data).toHaveProperty('model', 'claude-sonnet-4-6');
  });
});
