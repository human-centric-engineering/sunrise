/**
 * Integration tests for the per-case PATCH endpoint.
 *
 *   PATCH /api/v1/admin/orchestration/evaluations/datasets/:id/cases/:position
 *
 * Coverage:
 * - Auth + ownership gates
 * - 404 for missing dataset / missing position
 * - Validation: empty body, invalid types, malformed position
 * - Happy path applies the patch, re-hashes, returns updated case
 * - `expectedOutput: null` clears the field
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const transactionRunner = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiDataset: { findFirst: vi.fn(), update: vi.fn() },
    aiDatasetCase: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    $transaction: transactionRunner,
  },
}));

vi.mock('@/lib/orchestration/evaluations/datasets/hash', () => ({
  hashDatasetCases: vi.fn(() => 'new-hash-deadbeef'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { PATCH } from '@/app/api/v1/admin/orchestration/evaluations/datasets/[id]/cases/[position]/route';

const DATASET_ID = 'cmjbv4i3x00003wsloputgwu1';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'PATCH',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets/${DATASET_ID}/cases/0`,
  } as unknown as NextRequest;
}

function ctx(position = '0') {
  return { params: Promise.resolve({ id: DATASET_ID, position }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default transaction runner: invoke the callback with a tx that
  // proxies to the same mocked methods. Tests that want to drive the
  // tx differently can re-mock per-test.
  transactionRunner.mockImplementation(async (cb: unknown) => {
    const tx = {
      aiDataset: prisma.aiDataset,
      aiDatasetCase: prisma.aiDatasetCase,
      // Route takes `SELECT ... FOR UPDATE` on the parent dataset row at
      // the top of the transaction to serialise concurrent PATCHes. The
      // mock just needs to be callable.
      $queryRaw: vi.fn().mockResolvedValue([{ id: DATASET_ID }]),
    };
    return (cb as (t: typeof tx) => Promise<unknown>)(tx);
  });
});

describe('PATCH /datasets/:id/cases/:position — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await PATCH(makeRequest({ input: 'new' }), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await PATCH(makeRequest({ input: 'new' }), ctx());
    expect(res.status).toBe(403);
  });
});

describe('PATCH /datasets/:id/cases/:position — validation', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 400 on an empty patch body', async () => {
    const res = await PATCH(makeRequest({}), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 400 on a malformed position', async () => {
    const res = await PATCH(makeRequest({ input: 'new' }), ctx('not-a-number'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on a negative position', async () => {
    const res = await PATCH(makeRequest({ input: 'new' }), ctx('-1'));
    expect(res.status).toBe(400);
  });

  it('rejects extra fields (strict schema)', async () => {
    const res = await PATCH(makeRequest({ input: 'new', notAField: 'x' }), ctx());
    expect(res.status).toBe(400);
  });
});

describe('PATCH /datasets/:id/cases/:position — ownership', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 404 when the dataset is not owned by the caller', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null);
    const res = await PATCH(makeRequest({ input: 'new' }), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 404 when no case exists at the requested position', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: DATASET_ID } as never);
    vi.mocked(prisma.aiDatasetCase.findUnique).mockResolvedValue(null);
    const res = await PATCH(makeRequest({ input: 'new' }), ctx('42'));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /datasets/:id/cases/:position — happy path', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: DATASET_ID } as never);
    vi.mocked(prisma.aiDatasetCase.findUnique).mockResolvedValue({
      id: 'case-1',
      position: 0,
      input: 'old input',
      expectedOutput: 'old expected',
    } as never);
    vi.mocked(prisma.aiDatasetCase.findMany).mockResolvedValue([
      {
        position: 0,
        input: 'new input',
        expectedOutput: 'new expected',
        metadata: null,
        referenceCitations: null,
      },
    ] as never);
  });

  it('updates the case, re-hashes the dataset, returns the new state', async () => {
    vi.mocked(prisma.aiDatasetCase.update).mockResolvedValue({
      id: 'case-1',
      position: 0,
      input: 'new input',
      expectedOutput: 'new expected',
    } as never);

    const res = await PATCH(
      makeRequest({ input: 'new input', expectedOutput: 'new expected' }),
      ctx()
    );

    expect(res.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: { case: { input: string; expectedOutput: string }; contentHash: string };
    }>(res);
    expect(body.success).toBe(true);
    expect(body.data.case.input).toBe('new input');
    expect(body.data.case.expectedOutput).toBe('new expected');
    expect(body.data.contentHash).toBe('new-hash-deadbeef');
    expect(vi.mocked(prisma.aiDataset.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DATASET_ID },
        data: expect.objectContaining({ contentHash: 'new-hash-deadbeef' }),
      })
    );
  });

  it('expectedOutput: null clears the field', async () => {
    vi.mocked(prisma.aiDatasetCase.update).mockResolvedValue({
      id: 'case-1',
      position: 0,
      input: 'old input',
      expectedOutput: null,
    } as never);

    const res = await PATCH(makeRequest({ expectedOutput: null }), ctx());

    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.aiDatasetCase.update).mock.calls[0][0];
    expect(updateCall.data.expectedOutput).toBeNull();
  });

  it('metadata-only patch writes metadata without touching other fields', async () => {
    vi.mocked(prisma.aiDatasetCase.update).mockResolvedValue({
      id: 'case-1',
      position: 0,
      input: 'old input',
      expectedOutput: 'old expected',
    } as never);

    const res = await PATCH(makeRequest({ metadata: { intent: 'refund' } }), ctx());

    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.aiDatasetCase.update).mock.calls[0][0];
    expect(updateCall.data).toEqual({ metadata: { intent: 'refund' } });
  });

  it('metadata: null writes Prisma.JsonNull (clears the field)', async () => {
    vi.mocked(prisma.aiDatasetCase.update).mockResolvedValue({
      id: 'case-1',
      position: 0,
      input: 'old input',
      expectedOutput: null,
    } as never);

    const res = await PATCH(makeRequest({ metadata: null }), ctx());

    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.aiDatasetCase.update).mock.calls[0][0];
    // Prisma.JsonNull is a sentinel object — not the literal `null`.
    expect(updateCall.data.metadata).toBeDefined();
    expect(updateCall.data.metadata).not.toBe(null);
  });

  it('referenceCitations-only patch writes citations without touching other fields', async () => {
    vi.mocked(prisma.aiDatasetCase.update).mockResolvedValue({
      id: 'case-1',
      position: 0,
      input: 'old input',
      expectedOutput: 'old expected',
    } as never);

    const res = await PATCH(
      makeRequest({ referenceCitations: [{ title: 'Policy', uri: 'https://x' }] }),
      ctx()
    );

    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.aiDatasetCase.update).mock.calls[0][0];
    expect(updateCall.data.referenceCitations).toEqual([{ title: 'Policy', uri: 'https://x' }]);
    expect(updateCall.data.input).toBeUndefined();
    expect(updateCall.data.expectedOutput).toBeUndefined();
  });

  it('referenceCitations: null writes Prisma.JsonNull', async () => {
    vi.mocked(prisma.aiDatasetCase.update).mockResolvedValue({
      id: 'case-1',
      position: 0,
      input: 'old input',
      expectedOutput: null,
    } as never);

    const res = await PATCH(makeRequest({ referenceCitations: null }), ctx());

    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.aiDatasetCase.update).mock.calls[0][0];
    expect(updateCall.data.referenceCitations).toBeDefined();
    expect(updateCall.data.referenceCitations).not.toBe(null);
  });
});
