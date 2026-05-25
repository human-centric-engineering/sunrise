/**
 * Integration Test: Admin Orchestration — Single Dataset (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/evaluations/datasets/:id
 * PATCH  /api/v1/admin/orchestration/evaluations/datasets/:id
 * DELETE /api/v1/admin/orchestration/evaluations/datasets/:id
 *
 * @see app/api/v1/admin/orchestration/evaluations/datasets/[id]/route.ts
 *
 * Coverage matrix:
 * - 401 / 403 on auth boundary for every verb
 * - 400 on non-CUID id
 * - 404 when dataset is owned by a different user (ownership scoping)
 * - GET happy path returns dataset + first 50 cases
 * - PATCH happy path: name / description / tags
 * - PATCH 400 when no fields provided
 * - DELETE happy path
 * - DELETE 409 when an active (queued/running) run references the dataset
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  GET,
  PATCH,
  DELETE,
} from '@/app/api/v1/admin/orchestration/evaluations/datasets/[id]/route';
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
    aiDataset: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    aiDatasetCase: {
      findMany: vi.fn(),
    },
    aiEvaluationRun: {
      findFirst: vi.fn(),
    },
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

function makeDatasetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DATASET_ID,
    userId: ADMIN_ID,
    name: 'd',
    description: null,
    tags: [],
    caseCount: 1,
    contentHash: 'h',
    source: 'manual',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(id: string): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets/${id}`
  );
  return new NextRequest(url);
}

function makePatchRequest(id: string, body: Record<string, unknown>): NextRequest {
  return {
    method: 'PATCH',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets/${id}`,
  } as unknown as NextRequest;
}

function makeDeleteRequest(id: string): NextRequest {
  return {
    method: 'DELETE',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets/${id}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/evaluations/datasets/:id', () => {
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

  it('returns 404 when dataset belongs to another user (cross-user scoping)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // findFirst returns null because the WHERE clause filters by userId.
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null);

    const response = await GET(makeGetRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(404);
    // Confirm the scoping clause was actually applied.
    expect(vi.mocked(prisma.aiDataset.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: DATASET_ID, userId: ADMIN_ID }),
      })
    );
  });

  it('returns 200 with dataset + first 50 cases preview', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(makeDatasetRow() as never);
    vi.mocked(prisma.aiDatasetCase.findMany).mockResolvedValue([
      { id: 'c1', position: 0 } as never,
    ]);

    const response = await GET(makeGetRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: { dataset: { id: string }; cases: Array<{ id: string }> };
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data.dataset.id).toBe(DATASET_ID);
    expect(data.data.cases).toHaveLength(1);
    expect(vi.mocked(prisma.aiDatasetCase.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, orderBy: { position: 'asc' } })
    );
  });
});

describe('PATCH /api/v1/admin/orchestration/evaluations/datasets/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await PATCH(
      makePatchRequest(DATASET_ID, { name: 'x' }),
      makeParams(DATASET_ID)
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(
      makePatchRequest(INVALID_ID, { name: 'x' }),
      makeParams(INVALID_ID)
    );

    expect(response.status).toBe(400);
  });

  it('returns 404 when dataset belongs to another user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null);

    const response = await PATCH(
      makePatchRequest(DATASET_ID, { name: 'x' }),
      makeParams(DATASET_ID)
    );

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiDataset.update)).not.toHaveBeenCalled();
  });

  it('returns 400 when body is empty (refine: at least one field required)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(makeDatasetRow() as never);

    const response = await PATCH(makePatchRequest(DATASET_ID, {}), makeParams(DATASET_ID));

    expect(response.status).toBe(400);
    expect(vi.mocked(prisma.aiDataset.update)).not.toHaveBeenCalled();
  });

  it('returns 200 and updates only provided fields', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(makeDatasetRow() as never);
    vi.mocked(prisma.aiDataset.update).mockResolvedValue(
      makeDatasetRow({ name: 'renamed', tags: ['x'] }) as never
    );

    const response = await PATCH(
      makePatchRequest(DATASET_ID, { name: 'renamed', tags: ['x'] }),
      makeParams(DATASET_ID)
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(prisma.aiDataset.update)).toHaveBeenCalledWith({
      where: { id: DATASET_ID },
      data: { name: 'renamed', tags: ['x'] },
    });
  });

  it('allows description: null to clear the field', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(makeDatasetRow() as never);
    vi.mocked(prisma.aiDataset.update).mockResolvedValue(
      makeDatasetRow({ description: null }) as never
    );

    const response = await PATCH(
      makePatchRequest(DATASET_ID, { description: null }),
      makeParams(DATASET_ID)
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(prisma.aiDataset.update)).toHaveBeenCalledWith({
      where: { id: DATASET_ID },
      data: { description: null },
    });
  });
});

describe('DELETE /api/v1/admin/orchestration/evaluations/datasets/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await DELETE(makeDeleteRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await DELETE(makeDeleteRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(403);
  });

  it('returns 400 when id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await DELETE(makeDeleteRequest(INVALID_ID), makeParams(INVALID_ID));

    expect(response.status).toBe(400);
  });

  it('returns 404 when dataset belongs to another user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiDataset.delete)).not.toHaveBeenCalled();
  });

  it('returns 409 when an active (queued/running) run references the dataset', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(makeDatasetRow() as never);
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue({
      id: 'run-1',
      name: 'blocking run',
      status: 'running',
    } as never);

    const response = await DELETE(makeDeleteRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(409);
    const data = await parseJson<{ error: { code: string; message: string } }>(response);
    expect(data.error.code).toBe('CONFLICT');
    expect(data.error.message).toContain('blocking run');
    expect(vi.mocked(prisma.aiDataset.delete)).not.toHaveBeenCalled();
  });

  it('returns 200 and deletes the dataset on the happy path', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(makeDatasetRow() as never);
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiDataset.delete).mockResolvedValue(makeDatasetRow() as never);

    const response = await DELETE(makeDeleteRequest(DATASET_ID), makeParams(DATASET_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{ data: { deleted: boolean; id: string } }>(response);
    expect(data.data.deleted).toBe(true);
    expect(data.data.id).toBe(DATASET_ID);
    expect(vi.mocked(prisma.aiDataset.delete)).toHaveBeenCalledWith({ where: { id: DATASET_ID } });
  });
});
