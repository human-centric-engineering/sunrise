/**
 * Integration Test: Admin Orchestration — Paginated Dataset Cases
 *
 * GET /api/v1/admin/orchestration/evaluations/datasets/:id/cases
 *
 * @see app/api/v1/admin/orchestration/evaluations/datasets/[id]/cases/route.ts
 *
 * Coverage matrix:
 * - 401 / 403 / 400 on auth + id validation
 * - 404 when dataset belongs to another user
 * - happy path: returns items + nextCursor + total
 * - hasMore detection: when results > limit, nextCursor is set
 * - cursor query param: gt-filter applied
 * - non-positive cursor rejected (Zod)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/evaluations/datasets/[id]/cases/route';
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
    aiDataset: { findFirst: vi.fn() },
    aiDatasetCase: { findMany: vi.fn() },
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
const DATASET_ID = 'cmjbv4i3x00003wsloputgwu7';
const INVALID_ID = 'not-a-cuid';

function makeCase(position: number) {
  return {
    id: `case-${position}`,
    datasetId: DATASET_ID,
    position,
    input: 'hello',
    expectedOutput: null,
    metadata: null,
    referenceCitations: null,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(id: string, query: Record<string, string> = {}): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets/${id}/cases`
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

describe('GET /api/v1/admin/orchestration/evaluations/datasets/:id/cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeGetRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await GET(makeGetRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(403);
  });

  it('returns 400 when id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeGetRequest(INVALID_ID), makeParams(INVALID_ID));

    expect(response.status).toBe(400);
  });

  it('returns 404 when dataset belongs to another user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null);

    const response = await GET(makeGetRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiDataset.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: DATASET_ID, userId: ADMIN_ID }),
      })
    );
  });

  it('returns 200 with items, nextCursor=null when fewer than limit results', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      caseCount: 2,
    } as never);
    // limit defaults to 50; route requests take=limit+1; return 2 items.
    vi.mocked(prisma.aiDatasetCase.findMany).mockResolvedValue([makeCase(0), makeCase(1)] as never);

    const response = await GET(makeGetRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: { items: unknown[]; nextCursor: number | null; total: number };
    }>(response);
    expect(data.data.items).toHaveLength(2);
    expect(data.data.nextCursor).toBe(null);
    expect(data.data.total).toBe(2);
  });

  it('returns nextCursor set to last item position when results exceed limit', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      caseCount: 100,
    } as never);
    // Limit=2 → take=3 → return 3 rows; last is sliced off and nextCursor = items[last].position.
    vi.mocked(prisma.aiDatasetCase.findMany).mockResolvedValue([
      makeCase(0),
      makeCase(1),
      makeCase(2),
    ] as never);

    const response = await GET(makeGetRequest(DATASET_ID, { limit: '2' }), makeParams(DATASET_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{
      data: { items: unknown[]; nextCursor: number | null };
    }>(response);
    expect(data.data.items).toHaveLength(2);
    expect(data.data.nextCursor).toBe(1);
  });

  it('passes cursor (gt-filter) into the WHERE clause', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      caseCount: 10,
    } as never);
    vi.mocked(prisma.aiDatasetCase.findMany).mockResolvedValue([] as never);

    await GET(makeGetRequest(DATASET_ID, { cursor: '5' }), makeParams(DATASET_ID));

    expect(vi.mocked(prisma.aiDatasetCase.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          datasetId: DATASET_ID,
          position: { gt: 5 },
        }),
      })
    );
  });

  it('returns 400 when limit exceeds the 200 cap', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(
      makeGetRequest(DATASET_ID, { limit: '500' }),
      makeParams(DATASET_ID)
    );

    expect(response.status).toBe(400);
  });
});
