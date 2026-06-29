/**
 * Integration Test: Admin Orchestration Agents (list + create)
 *
 * GET  /api/v1/admin/orchestration/agents
 * POST /api/v1/admin/orchestration/agents
 *
 * @see app/api/v1/admin/orchestration/agents/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/agents/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { Prisma } from '@prisma/client';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => {
  const mock = {
    aiAgent: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    // Create now writes a v1 "Initial configuration" version in the same
    // transaction as the agent row.
    aiAgentVersion: {
      create: vi.fn(),
    },
    aiCostLog: {
      groupBy: vi.fn(),
    },
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  // $transaction runs the callback with the mock itself as the tx client.
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => Promise<unknown>) => fn(mock));
  return { prisma: mock };
});

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  getMonthToDateGlobalSpend: vi.fn(),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    systemInstructions: 'You are a helpful assistant.',
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
    _count: { capabilities: 0, conversations: 0 },
    _budget: null,
    ...overrides,
  };
}

const VALID_AGENT = {
  name: 'Test Agent',
  slug: 'test-agent',
  description: 'A test agent for integration tests',
  systemInstructions: 'You are a helpful assistant for testing.',
  model: 'claude-3-5-sonnet-20241022',
  provider: 'anthropic',
  temperature: 0.7,
  maxTokens: 4096,
  isActive: true,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/agents');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/agents',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(403);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    });
  });

  describe('Successful retrieval', () => {
    it('returns paginated agents list for admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const agents = [makeAgent(), makeAgent({ id: 'cmjbv4i3x00003wsloputgwu2', slug: 'agent-2' })];
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(agents as never);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(2);
      vi.mocked(prisma.aiCostLog.groupBy).mockResolvedValue([] as never);
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: Array<{ _count: unknown; _budget: unknown }>;
        meta: unknown;
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
      expect(data.meta).toBeDefined();
      expect(data.data[0]).toHaveProperty('_count');
      expect(data.data[0]).toHaveProperty('_budget');
    });

    it('returns empty array when no agents exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: unknown[] }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(0);
    });

    it('annotates _budget with globalCapExceeded when month-to-date global spend exceeds the cap', async () => {
      // Drives the globalCap branch around L86-103: settings has a
      // global cap, spend groupBy returns enough total spend to
      // exceed it, and each agent's _budget summary should carry
      // globalCapExceeded: true. Previously uncovered because the
      // happy-path test left global spend at 0.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const agent = makeAgent();
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([agent] as never);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(1);
      vi.mocked(prisma.aiCostLog.groupBy).mockResolvedValue([
        { agentId: agent.id, _sum: { totalCostUsd: 5 } },
      ] as never);
      // The route imports getMonthToDateGlobalSpend; that helper is
      // already mocked at the top of this file. Mock its return so
      // global spend exceeds the cap defined below.
      const { getMonthToDateGlobalSpend } = await import('@/lib/orchestration/llm/cost-tracker');
      vi.mocked(getMonthToDateGlobalSpend).mockResolvedValue(110);
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
        slug: 'global',
        globalMonthlyBudgetUsd: 100,
      } as never);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: Array<{ _budget: { globalCapExceeded?: boolean; withinBudget: boolean } | null }>;
      }>(response);
      expect(data.data[0]._budget).toMatchObject({
        globalCapExceeded: true,
        withinBudget: false,
      });
    });

    it('returns null budgets when the cost-log aggregation fails (catch arm)', async () => {
      // Drives the catch arm around L108-112 — if the budget batch
      // throws, the route logs warn and returns null _budget rather
      // than 500. Previously uncovered.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([makeAgent()] as never);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(1);
      vi.mocked(prisma.aiCostLog.groupBy).mockRejectedValue(new Error('DB connection lost'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: Array<{ _budget: unknown }>;
      }>(response);
      expect(data.data[0]._budget).toBeNull();
    });
  });

  describe('Filtering', () => {
    it('passes isActive filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      await GET(makeGetRequest({ isActive: 'true' }));

      expect(vi.mocked(prisma.aiAgent.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
          include: expect.objectContaining({
            _count: { select: { capabilities: true, conversations: true } },
          }),
        })
      );
    });

    it('passes provider filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      await GET(makeGetRequest({ provider: 'openai' }));

      expect(vi.mocked(prisma.aiAgent.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ provider: 'openai' }),
          include: expect.objectContaining({
            _count: { select: { capabilities: true, conversations: true } },
          }),
        })
      );
    });

    it('passes search query as OR filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'support' }));

      expect(vi.mocked(prisma.aiAgent.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
          include: expect.objectContaining({
            _count: { select: { capabilities: true, conversations: true } },
          }),
        })
      );
    });

    it('hides soft-deleted agents (deletedAt set) but keeps inactive ones visible', async () => {
      // Regression: a clone is created with isActive=false (so the operator
      // can review before enabling), but the previous list filter forced
      // isActive=true and hid those clones. The list distinguishes
      // "soft-deleted" (deletedAt set by DELETE) from "inactive but still
      // meant to appear" (a clone, or an agent toggled off via the table
      // switch). A prior fix hung this off a slug-tombstone substring,
      // which leaked legacy soft-deletes whose slug was never renamed —
      // deletedAt is now the authoritative signal.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      await GET(makeGetRequest({}));

      const call = vi.mocked(prisma.aiAgent.findMany).mock.calls[0]?.[0] as
        | { where: Record<string, unknown> }
        | undefined;
      expect(call).toBeDefined();
      expect(call!.where).toMatchObject({ deletedAt: null });
      expect(call!.where).not.toHaveProperty('isActive');
      expect(call!.where).not.toHaveProperty('slug');
    });
  });

  describe('Ordering', () => {
    it('orders by [isSystem asc, lastActiveAt desc nulls last, createdAt desc]', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

      await GET(makeGetRequest({}));

      // Bespoke agents first (`isSystem asc`), then most recently active
      // within each bucket (`lastActiveAt desc nulls last`), then
      // createdAt desc as the final tiebreaker. See the agents list
      // route comment for the rationale.
      expect(vi.mocked(prisma.aiAgent.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { isSystem: 'asc' },
            { lastActiveAt: { sort: 'desc', nulls: 'last' } },
            { createdAt: 'desc' },
          ],
        })
      );
    });
  });
});

describe('POST /api/v1/admin/orchestration/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(VALID_AGENT));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(VALID_AGENT));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful creation', () => {
    it('creates agent and returns 201', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const created = makeAgent();
      vi.mocked(prisma.aiAgent.create).mockResolvedValue(created as never);

      const response = await POST(makePostRequest(VALID_AGENT));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: unknown }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toMatchObject({ slug: 'test-agent' });
    });

    it('writes an "Initial configuration" v1 snapshot of the new agent', async () => {
      // Point-in-time versioning makes the original config a first-class,
      // restorable entry from creation, so a single later edit can be rolled
      // back. A green-bar version would pass without any version write.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const created = makeAgent({ id: AGENT_ID, model: 'claude-opus-4-8' });
      vi.mocked(prisma.aiAgent.create).mockResolvedValue(created as never);

      await POST(makePostRequest(VALID_AGENT));

      expect(vi.mocked(prisma.aiAgentVersion.create)).toHaveBeenCalledTimes(1);
      const versionCall = vi.mocked(prisma.aiAgentVersion.create).mock.calls[0][0];
      expect(versionCall.data).toMatchObject({
        agentId: AGENT_ID,
        version: 1,
        changeSummary: 'Initial configuration',
      });
      // The snapshot captures the created agent's config (point-in-time), with
      // empty grants for a fresh agent.
      const snapshot = versionCall.data.snapshot as Record<string, unknown>;
      expect(snapshot).toMatchObject({ model: 'claude-opus-4-8' });
      expect(snapshot).toHaveProperty('grantedTagIds', []);
      expect(snapshot).toHaveProperty('grantedDocumentIds', []);
    });

    it('stores createdBy from session user id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.create).mockResolvedValue(makeAgent() as never);

      await POST(makePostRequest(VALID_AGENT));

      expect(vi.mocked(prisma.aiAgent.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdBy: ADMIN_ID }),
        })
      );
    });

    it('persists persona, guardrails, mode columns, and profileId from the request body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.create).mockResolvedValue(makeAgent() as never);

      await POST(
        makePostRequest({
          ...VALID_AGENT,
          profileId: 'cmjbv4i3x00003wsloputgwu7',
          persona: 'Be wise.',
          guardrails: 'No PII.',
          personaMode: 'append',
          voiceMode: 'append',
          guardrailsMode: 'append',
        })
      );

      expect(vi.mocked(prisma.aiAgent.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            profileId: 'cmjbv4i3x00003wsloputgwu7',
            persona: 'Be wise.',
            guardrails: 'No PII.',
            personaMode: 'append',
            voiceMode: 'append',
            guardrailsMode: 'append',
          }),
        })
      );
    });
  });

  describe('Validation errors', () => {
    it('returns 400 for missing required fields', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({}));

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 for invalid slug format', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ ...VALID_AGENT, slug: 'INVALID SLUG!' }));

      expect(response.status).toBe(400);
    });
  });

  describe('Conflict errors', () => {
    it('returns 409 when slug already exists (P2002)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiAgent.create).mockRejectedValue(p2002);

      const response = await POST(makePostRequest(VALID_AGENT));

      expect(response.status).toBe(409);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    });
  });
});
