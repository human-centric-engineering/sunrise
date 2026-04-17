/**
 * Integration Test: Agent performance comparison
 *
 * GET /api/v1/admin/orchestration/agents/compare?agentIds=id1,id2
 *
 * @see app/api/v1/admin/orchestration/agents/compare/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/agents/compare/route';
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
    aiAgent: { findUnique: vi.fn() },
    aiCostLog: { aggregate: vi.fn() },
    aiConversation: { count: vi.fn() },
    aiAgentCapability: { count: vi.fn() },
    aiEvaluationSession: { count: vi.fn() },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Helpers ────────────────────────────────────────────────────────────────

const AGENT_A = 'cmjbv4i3x00003wsloputgwul';
const AGENT_B = 'cmjbv4i3x00003wsloqutgwu2';

function makeRequest(agentIds?: string) {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/agents/compare');
  if (agentIds) url.searchParams.set('agentIds', agentIds);
  return new NextRequest(url);
}

function mockAgent(id: string, name: string) {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    isActive: true,
    createdAt: new Date(),
  };
}

function mockCostAgg(overrides: Record<string, unknown> = {}) {
  return {
    _sum: { totalCostUsd: 0.5, inputTokens: 10000, outputTokens: 5000 },
    _count: 42,
    ...overrides,
  };
}

function setupAgentMocks() {
  // findUnique returns different agents based on the where clause
  vi.mocked(prisma.aiAgent.findUnique)
    .mockResolvedValueOnce(mockAgent(AGENT_A, 'Agent Alpha') as never)
    .mockResolvedValueOnce(mockAgent(AGENT_B, 'Agent Beta') as never);
  vi.mocked(prisma.aiCostLog.aggregate)
    .mockResolvedValueOnce(mockCostAgg() as never)
    .mockResolvedValueOnce(
      mockCostAgg({
        _sum: { totalCostUsd: 1.2, inputTokens: 20000, outputTokens: 8000 },
        _count: 80,
      }) as never
    );
  vi.mocked(prisma.aiConversation.count)
    .mockResolvedValueOnce(10 as never)
    .mockResolvedValueOnce(25 as never);
  vi.mocked(prisma.aiAgentCapability.count)
    .mockResolvedValueOnce(3 as never)
    .mockResolvedValueOnce(5 as never);
  vi.mocked(prisma.aiEvaluationSession.count)
    .mockResolvedValueOnce(4 as never) // agent A total
    .mockResolvedValueOnce(2 as never) // agent A completed
    .mockResolvedValueOnce(6 as never) // agent B total
    .mockResolvedValueOnce(5 as never); // agent B completed
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Agent Comparison', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 for unauthenticated user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await GET(makeRequest(`${AGENT_A},${AGENT_B}`));
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    const res = await GET(makeRequest(`${AGENT_A},${AGENT_B}`));
    expect(res.status).toBe(403);
  });

  it('returns 400 when agentIds is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it('returns 400 when only one agentId is provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await GET(makeRequest(AGENT_A));
    expect(res.status).toBe(400);
  });

  it('returns 400 when agent is not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(mockAgent(AGENT_B, 'Agent Beta') as never);
    vi.mocked(prisma.aiCostLog.aggregate).mockResolvedValue(mockCostAgg() as never);
    vi.mocked(prisma.aiConversation.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.aiAgentCapability.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(0 as never);

    const res = await GET(makeRequest(`${AGENT_A},${AGENT_B}`));
    expect(res.status).toBe(400);
  });

  it('returns comparison data for two valid agents', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    setupAgentMocks();

    const res = await GET(makeRequest(`${AGENT_A},${AGENT_B}`));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: ComparisonResponse };
    expect(body.data.agents).toHaveLength(2);

    const [agentA, agentB] = body.data.agents;
    expect(agentA.name).toBe('Agent Alpha');
    expect(agentB.name).toBe('Agent Beta');
  });

  it('includes cost and token aggregates', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    setupAgentMocks();

    const res = await GET(makeRequest(`${AGENT_A},${AGENT_B}`));
    const body = (await res.json()) as { data: ComparisonResponse };

    const [agentA, agentB] = body.data.agents;
    expect(agentA.totalCostUsd).toBe(0.5);
    expect(agentA.llmCallCount).toBe(42);
    expect(agentB.totalCostUsd).toBe(1.2);
    expect(agentB.llmCallCount).toBe(80);
  });

  it('includes conversation and capability counts', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    setupAgentMocks();

    const res = await GET(makeRequest(`${AGENT_A},${AGENT_B}`));
    const body = (await res.json()) as { data: ComparisonResponse };

    const [agentA, agentB] = body.data.agents;
    expect(agentA.conversationCount).toBe(10);
    expect(agentA.capabilityCount).toBe(3);
    expect(agentB.conversationCount).toBe(25);
    expect(agentB.capabilityCount).toBe(5);
  });

  it('includes evaluation summaries', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    setupAgentMocks();

    const res = await GET(makeRequest(`${AGENT_A},${AGENT_B}`));
    const body = (await res.json()) as { data: ComparisonResponse };

    const [agentA, agentB] = body.data.agents;
    expect(agentA.evaluations.total).toBe(4);
    expect(agentA.evaluations.completed).toBe(2);
    expect(agentB.evaluations.total).toBe(6);
    expect(agentB.evaluations.completed).toBe(5);
  });
});

// ─── Type helpers ────────────────────────────────────────────────────────────

interface AgentStats {
  id: string;
  name: string;
  slug: string;
  model: string;
  provider: string;
  isActive: boolean;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  llmCallCount: number;
  conversationCount: number;
  capabilityCount: number;
  evaluations: {
    total: number;
    completed: number;
  };
}

interface ComparisonResponse {
  agents: [AgentStats, AgentStats];
}
