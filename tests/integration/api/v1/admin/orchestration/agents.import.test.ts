/**
 * Integration Test: Admin Orchestration Agents Import
 *
 * POST /api/v1/admin/orchestration/agents/import
 *   Body: { bundle: AgentBundle, conflictMode?: 'skip' | 'overwrite' }
 *
 * All DB work runs in a single prisma.$transaction.
 * capabilityDispatcher.clearCache() is called exactly once on success.
 * Unknown capability slugs go to results.warnings — do not fail the import.
 *
 * @see app/api/v1/admin/orchestration/agents/import/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/agents/import/route';
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

/**
 * We mock the Prisma client with a $transaction that invokes the callback
 * with a transactional client (tx). The tx object mirrors the same models
 * we need in the import handler.
 */
vi.mock('@/lib/db/client', () => {
  const txMock = {
    aiAgent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    aiAgentCapability: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };

  return {
    prisma: {
      aiCapability: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock)),
      _txMock: txMock, // expose for test assertions
    },
  };
});

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/capabilities', () => ({
  capabilityDispatcher: { clearCache: vi.fn() },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const CAPABILITY_ID = 'cmjbv4i3x00003wsloputgwu2';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

/** A minimal but complete bundled agent that passes all Zod validations */
function makeBundledAgent(slug: string, capabilities: Array<{ slug: string }> = []) {
  return {
    name: `Agent ${slug}`,
    slug,
    description: 'Test agent for import',
    systemInstructions: 'You are a test agent.',
    systemInstructionsHistory: [],
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    temperature: 0.7,
    maxTokens: 4096,
    isActive: true,
    capabilities: capabilities.map((c) => ({
      slug: c.slug,
      isEnabled: true,
    })),
  };
}

function makeBundle(agents: ReturnType<typeof makeBundledAgent>[]) {
  return {
    version: '1' as const,
    exportedAt: '2025-01-01T00:00:00.000Z',
    agents,
  };
}

function makeDbAgent(id: string, slug: string) {
  return {
    id,
    name: `Agent ${slug}`,
    slug,
    description: 'Existing agent',
    systemInstructions: 'Old instructions.',
    systemInstructionsHistory: [],
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    providerConfig: null,
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    metadata: null,
    isActive: true,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

/** Get the transaction mock object injected into the import handler */
function getTxMock() {
  return (prisma as unknown as Record<string, unknown>)._txMock as {
    aiAgent: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    aiAgentCapability: {
      deleteMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/agents/import',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/agents/import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);

    // Default: no existing agents (clean import), no capabilities
    const tx = getTxMock();
    tx.aiAgent.findUnique.mockResolvedValue(null);
    tx.aiAgent.create.mockResolvedValue({ id: AGENT_ID, slug: 'new-agent' });
    tx.aiAgent.update.mockResolvedValue({ id: AGENT_ID });
    tx.aiAgentCapability.deleteMany.mockResolvedValue({ count: 0 });
    tx.aiAgentCapability.createMany.mockResolvedValue({ count: 0 });

    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(
        makeRequest({ bundle: makeBundle([makeBundledAgent('new-agent')]) })
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(
        makeRequest({ bundle: makeBundle([makeBundledAgent('new-agent')]) })
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST (mutating route)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makeRequest({ bundle: makeBundle([makeBundledAgent('new-agent')]) }));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });

  describe('Clean import (new agents)', () => {
    it('creates agents and returns imported count', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(null);

      const response = await POST(
        makeRequest({ bundle: makeBundle([makeBundledAgent('new-agent')]) })
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { imported: number; skipped: number; overwritten: number; warnings: string[] };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.imported).toBe(1);
      expect(data.data.skipped).toBe(0);
      expect(data.data.overwritten).toBe(0);
    });

    it('creates capability pivot rows when capabilities exist in db', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([
        { id: CAPABILITY_ID, slug: 'search-web' },
      ] as never);
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(null);

      await POST(
        makeRequest({
          bundle: makeBundle([makeBundledAgent('new-agent', [{ slug: 'search-web' }])]),
        })
      );

      expect(tx.aiAgentCapability.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([expect.objectContaining({ capabilityId: CAPABILITY_ID })]),
        })
      );
    });

    it('runs all db operations inside a single $transaction', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makeRequest({ bundle: makeBundle([makeBundledAgent('new-agent')]) }));

      expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledOnce();
    });
  });

  describe('conflictMode: skip', () => {
    it('leaves existing agent untouched and increments skipped count', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(makeDbAgent(AGENT_ID, 'existing-agent'));

      const response = await POST(
        makeRequest({
          bundle: makeBundle([makeBundledAgent('existing-agent')]),
          conflictMode: 'skip',
        })
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { imported: number; skipped: number; overwritten: number };
      }>(response);
      expect(data.data.skipped).toBe(1);
      expect(data.data.imported).toBe(0);
      expect(data.data.overwritten).toBe(0);

      // Must NOT have called create or update
      expect(tx.aiAgent.create).not.toHaveBeenCalled();
      expect(tx.aiAgent.update).not.toHaveBeenCalled();
    });

    it('skips existing and imports new in the same bundle', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const tx = getTxMock();
      tx.aiAgent.findUnique
        .mockResolvedValueOnce(makeDbAgent(AGENT_ID, 'existing-agent')) // first agent exists
        .mockResolvedValueOnce(null); // second agent is new

      const response = await POST(
        makeRequest({
          bundle: makeBundle([makeBundledAgent('existing-agent'), makeBundledAgent('new-agent')]),
          conflictMode: 'skip',
        })
      );

      const data = await parseJson<{
        data: { imported: number; skipped: number };
      }>(response);
      expect(data.data.skipped).toBe(1);
      expect(data.data.imported).toBe(1);
    });
  });

  describe('conflictMode: overwrite', () => {
    it('updates existing agent and rebuilds capability pivots', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const existingAgent = makeDbAgent(AGENT_ID, 'existing-agent');
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(existingAgent);
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([
        { id: CAPABILITY_ID, slug: 'search-web' },
      ] as never);

      const response = await POST(
        makeRequest({
          bundle: makeBundle([makeBundledAgent('existing-agent', [{ slug: 'search-web' }])]),
          conflictMode: 'overwrite',
        })
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { overwritten: number; skipped: number; imported: number };
      }>(response);
      expect(data.data.overwritten).toBe(1);
      expect(data.data.skipped).toBe(0);
      expect(data.data.imported).toBe(0);

      // Should have updated (not created) the agent
      expect(tx.aiAgent.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: existingAgent.id } })
      );

      // Should delete old pivots then recreate
      expect(tx.aiAgentCapability.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agentId: existingAgent.id } })
      );
      expect(tx.aiAgentCapability.createMany).toHaveBeenCalled();
    });

    it('writes the imported widgetConfig through to the agent row (overwrite branch)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const existingAgent = makeDbAgent(AGENT_ID, 'existing-agent');
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(existingAgent);

      const stored = { primaryColor: '#16a34a', headerTitle: 'Council' };
      const bundledWithWidget = {
        ...makeBundledAgent('existing-agent'),
        widgetConfig: stored,
      };
      await POST(
        makeRequest({
          bundle: makeBundle([bundledWithWidget as ReturnType<typeof makeBundledAgent>]),
          conflictMode: 'overwrite',
        })
      );

      expect(tx.aiAgent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ widgetConfig: stored }),
        })
      );
    });

    it('skips system agents with a warning instead of overwriting', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const systemAgent = { ...makeDbAgent(AGENT_ID, 'system-agent'), isSystem: true };
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(systemAgent);

      const response = await POST(
        makeRequest({
          bundle: makeBundle([makeBundledAgent('system-agent')]),
          conflictMode: 'overwrite',
        })
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { overwritten: number; skipped: number; warnings: string[] };
      }>(response);
      expect(data.data.overwritten).toBe(0);
      expect(data.data.skipped).toBe(1);
      expect(data.data.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('cannot overwrite system agent')])
      );

      // Must NOT have updated the system agent
      expect(tx.aiAgent.update).not.toHaveBeenCalled();
    });
  });

  describe('Unknown capability slugs → warnings, not failures', () => {
    it('adds warning message for unknown slug and still completes import', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // No matching capabilities in DB
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(null);

      const response = await POST(
        makeRequest({
          bundle: makeBundle([makeBundledAgent('new-agent', [{ slug: 'unknown-capability' }])]),
        })
      );

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { imported: number; warnings: string[] };
      }>(response);
      expect(data.data.imported).toBe(1); // agent was still imported
      expect(data.data.warnings).toHaveLength(1);
      expect(data.data.warnings[0]).toContain('unknown-capability');
    });

    it('adds one warning per unknown slug and continues', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(null);

      const bundledAgentWithTwoUnknown = makeBundledAgent('new-agent', [
        { slug: 'unknown-cap-1' },
        { slug: 'unknown-cap-2' },
      ]);

      const response = await POST(
        makeRequest({ bundle: makeBundle([bundledAgentWithTwoUnknown]) })
      );

      const data = await parseJson<{ data: { warnings: string[] } }>(response);
      expect(data.data.warnings).toHaveLength(2);
    });

    it('does NOT create capability pivots for unknown slugs', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(null);

      await POST(
        makeRequest({
          bundle: makeBundle([makeBundledAgent('new-agent', [{ slug: 'ghost-capability' }])]),
        })
      );

      // createMany should not have been called since no valid pivots were found
      expect(tx.aiAgentCapability.createMany).not.toHaveBeenCalled();
    });
  });

  describe('capabilityDispatcher.clearCache', () => {
    it('calls clearCache exactly once after successful import', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const tx = getTxMock();
      tx.aiAgent.findUnique.mockResolvedValue(null);

      await POST(makeRequest({ bundle: makeBundle([makeBundledAgent('new-agent')]) }));

      expect(vi.mocked(capabilityDispatcher.clearCache)).toHaveBeenCalledOnce();
    });
  });

  describe('Duplicate slugs in bundle', () => {
    it('returns 400 when same slug appears twice in the import bundle', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makeRequest({
          bundle: makeBundle([
            makeBundledAgent('duplicate-slug'),
            makeBundledAgent('duplicate-slug'),
          ]),
        })
      );

      expect(response.status).toBe(400);
      const data = await parseJson<{
        success: boolean;
        error: { message: string };
      }>(response);
      expect(data.success).toBe(false);
      expect(data.error.message).toContain('Duplicate slugs');
      expect(data.error.message).toContain('duplicate-slug');

      // Must NOT have started a transaction
      expect(vi.mocked(prisma.$transaction)).not.toHaveBeenCalled();
    });
  });

  describe('Validation errors', () => {
    it('returns 400 for missing bundle', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest({}));

      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid bundle version', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makeRequest({
          bundle: {
            version: '2', // only '1' is valid
            exportedAt: '2025-01-01T00:00:00.000Z',
            agents: [makeBundledAgent('x')],
          },
        })
      );

      expect(response.status).toBe(400);
    });
  });
});
