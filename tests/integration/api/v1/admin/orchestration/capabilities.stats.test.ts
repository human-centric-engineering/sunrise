/**
 * Integration Test: Capability execution metrics
 *
 * GET /api/v1/admin/orchestration/capabilities/:id/stats
 *
 * @see app/api/v1/admin/orchestration/capabilities/[id]/stats/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/capabilities/[id]/stats/route';
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
    aiCapability: {
      findUnique: vi.fn(),
    },
    aiCostLog: {
      findMany: vi.fn(),
    },
    aiEvaluationLog: {
      findMany: vi.fn(),
    },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Helpers ────────────────────────────────────────────────────────────────

const CAP_ID = 'cmjbv4i3x00003wsloputgwul';
const CAP_SLUG = 'web-search';

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/capabilities/${CAP_ID}/stats`
  );
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeCostLog(overrides: Record<string, unknown> = {}) {
  return {
    totalCostUsd: 0.001,
    metadata: { slug: CAP_SLUG, success: true },
    createdAt: new Date('2026-04-15T10:00:00Z'),
    ...overrides,
  };
}

function makeEvalLog(overrides: Record<string, unknown> = {}) {
  return {
    executionTimeMs: 150,
    createdAt: new Date('2026-04-15T10:00:00Z'),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Capability Stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 for unauthenticated user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: CAP_ID }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: CAP_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent capability', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(null);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: CAP_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid period', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue({
      id: CAP_ID,
      slug: CAP_SLUG,
    } as never);

    const res = await GET(makeRequest({ period: 'invalid' }), {
      params: Promise.resolve({ id: CAP_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('returns zero metrics when no logs exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue({
      id: CAP_ID,
      slug: CAP_SLUG,
    } as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue([]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: CAP_ID }) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: CapabilityStatsResponse };
    expect(body.data.invocations).toBe(0);
    expect(body.data.successRate).toBe(0);
    expect(body.data.avgLatencyMs).toBe(0);
    expect(body.data.totalCostUsd).toBe(0);
    expect(body.data.dailyBreakdown).toEqual([]);
  });

  it('aggregates invocations and success rate from cost logs', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue({
      id: CAP_ID,
      slug: CAP_SLUG,
    } as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([
      makeCostLog({ metadata: { slug: CAP_SLUG, success: true } }),
      makeCostLog({ metadata: { slug: CAP_SLUG, success: true } }),
      makeCostLog({ metadata: { slug: CAP_SLUG, success: false } }),
    ] as never);
    vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue([]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: CAP_ID }) });
    const body = (await res.json()) as { data: CapabilityStatsResponse };

    expect(body.data.invocations).toBe(3);
    // 2/3 = 66.67%
    expect(body.data.successRate).toBe(66.67);
  });

  it('computes latency percentiles from evaluation logs', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue({
      id: CAP_ID,
      slug: CAP_SLUG,
    } as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([]);
    // 10 latency values: 50, 100, 150, 200, 250, 300, 350, 400, 450, 500
    vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue(
      [50, 100, 150, 200, 250, 300, 350, 400, 450, 500].map((ms) =>
        makeEvalLog({ executionTimeMs: ms })
      ) as never
    );

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: CAP_ID }) });
    const body = (await res.json()) as { data: CapabilityStatsResponse };

    expect(body.data.avgLatencyMs).toBe(275);
    expect(body.data.p50LatencyMs).toBe(250);
    expect(body.data.p95LatencyMs).toBe(500);
  });

  it('computes daily breakdown', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue({
      id: CAP_ID,
      slug: CAP_SLUG,
    } as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([
      makeCostLog({ createdAt: new Date('2026-04-15T10:00:00Z'), totalCostUsd: 0.001 }),
      makeCostLog({ createdAt: new Date('2026-04-15T11:00:00Z'), totalCostUsd: 0.002 }),
      makeCostLog({ createdAt: new Date('2026-04-16T09:00:00Z'), totalCostUsd: 0.003 }),
    ] as never);
    vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue([]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: CAP_ID }) });
    const body = (await res.json()) as { data: CapabilityStatsResponse };

    expect(body.data.dailyBreakdown).toHaveLength(2);
    expect(body.data.dailyBreakdown[0].date).toBe('2026-04-15');
    expect(body.data.dailyBreakdown[0].invocations).toBe(2);
    expect(body.data.dailyBreakdown[1].date).toBe('2026-04-16');
    expect(body.data.dailyBreakdown[1].invocations).toBe(1);
  });

  it('respects period parameter', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue({
      id: CAP_ID,
      slug: CAP_SLUG,
    } as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEvaluationLog.findMany).mockResolvedValue([]);

    const res = await GET(makeRequest({ period: '7d' }), {
      params: Promise.resolve({ id: CAP_ID }),
    });
    const body = (await res.json()) as { data: CapabilityStatsResponse };
    expect(body.data.period).toBe('7d');
  });
});

// ─── Type helpers ────────────────────────────────────────────────────────────

interface CapabilityStatsResponse {
  capabilityId: string;
  capabilitySlug: string;
  period: string;
  invocations: number;
  successRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd: number;
  dailyBreakdown: {
    date: string;
    invocations: number;
    successRate: number;
    costUsd: number;
  }[];
}
