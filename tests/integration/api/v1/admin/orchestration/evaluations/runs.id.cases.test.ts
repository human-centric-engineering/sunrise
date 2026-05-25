/**
 * Integration Test: Admin Orchestration — Paginated Per-Case Run Results
 *
 * GET /api/v1/admin/orchestration/evaluations/runs/:id/cases
 *
 * @see app/api/v1/admin/orchestration/evaluations/runs/[id]/cases/route.ts
 *
 * Coverage matrix:
 * - 401 / 403 / 400 on auth + CUID validation
 * - 404 when run belongs to another user
 * - happy path: items + nextCursor
 * - hasMore detection: nextCursor set when results > limit
 * - cursor query param: gt-filter applied
 * - limit > 200 rejected
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/evaluations/runs/[id]/cases/route';
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
    aiEvaluationRun: { findFirst: vi.fn() },
    aiEvaluationCaseResult: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const RUN_ID = 'cmjbv4i3x00003wsloputgwu1';
const INVALID_ID = 'not-a-cuid';

function makeCaseResult(position: number) {
  return {
    id: `cr-${position}`,
    runId: RUN_ID,
    casePosition: position,
    status: 'success',
    subjectOutput: 'output',
    metricScores: [],
    errorCode: null,
    latencyMs: 100,
    costUsd: 0.001,
    datasetCase: { input: 'in', expectedOutput: 'out', metadata: null },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(id: string, query: Record<string, string> = {}): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/evaluations/runs/${id}/cases`
  );
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/evaluations/runs/:id/cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeGetRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await GET(makeGetRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(403);
  });

  it('returns 400 when id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeGetRequest(INVALID_ID), makeParams(INVALID_ID));

    expect(response.status).toBe(400);
  });

  it('returns 404 when run belongs to another user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue(null);

    const response = await GET(makeGetRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiEvaluationRun.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: RUN_ID, userId: ADMIN_ID }),
      })
    );
  });

  it('returns 200 with items + nextCursor=null when no more pages', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue({
      id: RUN_ID,
      status: 'completed',
    } as never);
    vi.mocked(prisma.aiEvaluationCaseResult.findMany).mockResolvedValue([
      makeCaseResult(0),
      makeCaseResult(1),
    ] as never);

    const response = await GET(makeGetRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{
      data: { items: unknown[]; nextCursor: number | null };
    }>(response);
    expect(data.data.items).toHaveLength(2);
    expect(data.data.nextCursor).toBe(null);
  });

  it('sets nextCursor when more results exist than the limit', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue({
      id: RUN_ID,
      status: 'running',
    } as never);
    // limit=2 → take=3 → return 3 rows; nextCursor = items[1].casePosition.
    vi.mocked(prisma.aiEvaluationCaseResult.findMany).mockResolvedValue([
      makeCaseResult(0),
      makeCaseResult(1),
      makeCaseResult(2),
    ] as never);

    const response = await GET(makeGetRequest(RUN_ID, { limit: '2' }), makeParams(RUN_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{
      data: { items: unknown[]; nextCursor: number | null };
    }>(response);
    expect(data.data.items).toHaveLength(2);
    expect(data.data.nextCursor).toBe(1);
  });

  it('passes cursor as gt-filter into the WHERE clause', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue({
      id: RUN_ID,
      status: 'running',
    } as never);
    vi.mocked(prisma.aiEvaluationCaseResult.findMany).mockResolvedValue([] as never);

    await GET(makeGetRequest(RUN_ID, { cursor: '7' }), makeParams(RUN_ID));

    expect(vi.mocked(prisma.aiEvaluationCaseResult.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runId: RUN_ID,
          casePosition: { gt: 7 },
        }),
      })
    );
  });

  it('returns 400 when limit exceeds the 200 cap', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeGetRequest(RUN_ID, { limit: '500' }), makeParams(RUN_ID));

    expect(response.status).toBe(400);
  });
});
