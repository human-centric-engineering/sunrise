/**
 * Tests: Agent Version History & Restore
 *
 * GET  /api/v1/admin/orchestration/agents/:id/versions
 * GET  /api/v1/admin/orchestration/agents/:id/versions/:versionId
 * POST /api/v1/admin/orchestration/agents/:id/versions/:versionId (restore)
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
      update: vi.fn(),
    },
    aiAgentVersion: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
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
import { GET as ListVersions } from '@/app/api/v1/admin/orchestration/agents/[id]/versions/route';
import { GET as GetVersion } from '@/app/api/v1/admin/orchestration/agents/[id]/versions/[versionId]/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const VERSION_ID = 'cmjbv4i3x00003wsloputgwu3';

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    agentId: AGENT_ID,
    version: 1,
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

function makeListRequest(agentId: string, params: Record<string, string> = {}): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${agentId}/versions`
  );
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeDetailRequest(agentId: string, versionId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${agentId}/versions/${versionId}`
  );
}

function makeAgentIdParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeDetailParams(id: string, versionId: string) {
  return { params: Promise.resolve({ id, versionId }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset rate limiter to allow-by-default after each test
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('GET /agents/:id/versions (list)', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await ListVersions(makeListRequest(AGENT_ID), makeAgentIdParams(AGENT_ID));
    expect(response.status).toBe(401);
  });

  it('returns 404 when agent does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const response = await ListVersions(makeListRequest(AGENT_ID), makeAgentIdParams(AGENT_ID));
    expect(response.status).toBe(404);
  });

  it('returns paginated versions', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
    vi.mocked(prisma.aiAgentVersion.findMany).mockResolvedValue([
      makeVersion({ version: 2 }),
      makeVersion({ version: 1 }),
    ] as never);
    vi.mocked(prisma.aiAgentVersion.count).mockResolvedValue(2);

    const response = await ListVersions(makeListRequest(AGENT_ID), makeAgentIdParams(AGENT_ID));
    expect(response.status).toBe(200);

    const data = await parseJson<{
      success: boolean;
      data: Array<{ version: number }>;
      meta: { total: number };
    }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.success).toBe(true);
    expect(data.data).toHaveLength(2);
    expect(data.meta.total).toBe(2);
  });

  it('returns 400 for invalid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await ListVersions(makeListRequest('bad-id'), makeAgentIdParams('bad-id'));
    expect(response.status).toBe(400);
  });
});

describe('GET /agents/:id/versions/:versionId (detail)', () => {
  it('returns 404 when version does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(null);

    const response = await GetVersion(
      makeDetailRequest(AGENT_ID, VERSION_ID),
      makeDetailParams(AGENT_ID, VERSION_ID)
    );
    expect(response.status).toBe(404);
  });

  it('returns version with full snapshot', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(makeVersion() as never);

    const response = await GetVersion(
      makeDetailRequest(AGENT_ID, VERSION_ID),
      makeDetailParams(AGENT_ID, VERSION_ID)
    );
    expect(response.status).toBe(200);

    const data = await parseJson<{ data: { snapshot: Record<string, unknown> } }>(response);
    expect(data.data.snapshot.systemInstructions).toBe('old instructions');
  });

  it('returns 400 for invalid agent id on GET detail', async () => {
    // Arrange: non-CUID agent id
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GetVersion(
      makeDetailRequest('bad-id', VERSION_ID),
      makeDetailParams('bad-id', VERSION_ID)
    );

    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid version id on GET detail', async () => {
    // Arrange: non-CUID version id
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GetVersion(
      makeDetailRequest(AGENT_ID, 'bad-version-id'),
      makeDetailParams(AGENT_ID, 'bad-version-id')
    );

    expect(response.status).toBe(400);
  });
});

// POST restore tests are in [id]/versions/[versionId]/restore/route.test.ts
