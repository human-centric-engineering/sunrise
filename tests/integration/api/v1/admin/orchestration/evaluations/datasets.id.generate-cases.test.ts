/**
 * Integration tests: synthetic case generation routes.
 *
 *   POST /api/v1/admin/orchestration/evaluations/datasets/:id/generate-cases
 *   POST /api/v1/admin/orchestration/evaluations/datasets/:id/generate-cases/commit
 *
 * Coverage:
 * - Preview route: 401/403, body validation, dataset ownership, agent existence
 * - Preview route: synthesisLimiter sub-cap blocks 11th request in a window
 * - Preview happy path returns the generator result verbatim
 * - Commit route: 400 on missing cases, 404 on cross-user dataset, 201 happy path
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiDataset: { findFirst: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/evaluations/synthesis/case-generator', () => ({
  generateCases: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/datasets/append-cases', () => ({
  appendCasesToDataset: vi.fn(),
}));

const { synthesisCheck } = vi.hoisted(() => ({ synthesisCheck: vi.fn() }));
vi.mock('@/lib/security/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
    '@/lib/security/rate-limit'
  );
  return {
    ...actual,
    synthesisLimiter: { check: synthesisCheck, reset: vi.fn() },
  };
});

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { generateCases } from '@/lib/orchestration/evaluations/synthesis/case-generator';
import { appendCasesToDataset } from '@/lib/orchestration/evaluations/datasets/append-cases';
import { POST as PreviewPOST } from '@/app/api/v1/admin/orchestration/evaluations/datasets/[id]/generate-cases/route';
import { POST as CommitPOST } from '@/app/api/v1/admin/orchestration/evaluations/datasets/[id]/generate-cases/commit/route';

const DATASET_ID = 'cmjbv4i3x00003wsloputgwu1';

function makeRequest(body: Record<string, unknown>, suffix = ''): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets/${DATASET_ID}/generate-cases${suffix}`,
  } as unknown as NextRequest;
}

function ctx() {
  return { params: Promise.resolve({ id: DATASET_ID }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  synthesisCheck.mockReturnValue({
    success: true,
    remaining: 9,
    reset: Date.now() + 60_000,
    limit: 10,
  });
});

describe('POST /generate-cases (preview) — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await PreviewPOST(makeRequest({ agentId: 'a', mode: 'kb' }), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await PreviewPOST(makeRequest({ agentId: 'a', mode: 'kb' }), ctx());
    expect(res.status).toBe(403);
  });
});

describe('POST /generate-cases (preview) — rate limit', () => {
  it('returns 429 when the synthesisLimiter rejects the request', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    synthesisCheck.mockReturnValue({
      success: false,
      remaining: 0,
      reset: Date.now() + 60_000,
      limit: 10,
    });

    const res = await PreviewPOST(makeRequest({ agentId: 'a', mode: 'kb' }), ctx());

    expect(res.status).toBe(429);
    expect(vi.mocked(generateCases)).not.toHaveBeenCalled();
  });
});

describe('POST /generate-cases (preview) — validation + ownership', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 400 on missing mode', async () => {
    const res = await PreviewPOST(makeRequest({ agentId: 'a' }), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 404 when the dataset is not owned by the caller', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null as never);
    const res = await PreviewPOST(makeRequest({ agentId: 'a', mode: 'kb' }), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 404 when the subject agent does not exist', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: DATASET_ID } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null as never);
    const res = await PreviewPOST(makeRequest({ agentId: 'missing', mode: 'kb' }), ctx());
    expect(res.status).toBe(404);
  });
});

describe('POST /generate-cases (preview) — happy path', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: DATASET_ID } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'a' } as never);
  });

  it('returns the generator result verbatim under success:true', async () => {
    const fakeResult = {
      cases: [
        {
          input: 'q',
          expectedOutput: 'a',
          metadata: { source: 'synthetic', mode: 'kb' },
        },
      ],
      costUsd: 0.003,
      tokenUsage: { input: 100, output: 50 },
    };
    vi.mocked(generateCases).mockResolvedValue(fakeResult);

    const res = await PreviewPOST(
      makeRequest({ agentId: 'a', mode: 'kb', count: 1, topic: 'refunds' }),
      ctx()
    );

    expect(res.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: typeof fakeResult }>(res);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(fakeResult);
    expect(vi.mocked(generateCases)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'a',
        mode: 'kb',
        count: 1,
        topic: 'refunds',
      })
    );
  });
});

describe('POST /generate-cases/commit — happy path + guardrails', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 400 when no cases are provided', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: DATASET_ID } as never);
    const res = await CommitPOST(makeRequest({}, '/commit'), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 404 on cross-user dataset', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null as never);
    const res = await CommitPOST(
      makeRequest({ cases: [{ input: 'q', expectedOutput: 'a' }] }, '/commit'),
      ctx()
    );
    expect(res.status).toBe(404);
    expect(vi.mocked(appendCasesToDataset)).not.toHaveBeenCalled();
  });

  it('201 happy path: writes via appendCasesToDataset with source=synthetic', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: DATASET_ID } as never);
    vi.mocked(appendCasesToDataset).mockResolvedValue({
      datasetId: DATASET_ID,
      appendedCount: 1,
      newCaseCount: 5,
      newContentHash: 'h',
    });

    const res = await CommitPOST(
      makeRequest({ cases: [{ input: 'q', expectedOutput: 'a' }] }, '/commit'),
      ctx()
    );

    expect(res.status).toBe(201);
    expect(vi.mocked(appendCasesToDataset)).toHaveBeenCalledWith({
      datasetId: DATASET_ID,
      cases: [{ input: 'q', expectedOutput: 'a' }],
      source: 'synthetic',
    });
  });
});
