/**
 * Integration tests: GET /api/v1/admin/orchestration/experiments/:id/compare
 *
 * Coverage:
 * - 401 / 403 on missing or non-admin session
 * - 404 on missing experiment
 * - 404 on cross-user experiment (cannot leak existence)
 * - 200 happy path: projects rawScores from each variant's run summary
 *   into the response, accumulates the metric-slug union
 * - Falls back to meanOrNull when summary.stats is absent
 * - Drops non-numeric / non-array score entries
 *
 * @see app/api/v1/admin/orchestration/experiments/[id]/compare/route.ts
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
  prisma: { aiExperiment: { findUnique: vi.fn() } },
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { GET } from '@/app/api/v1/admin/orchestration/experiments/[id]/compare/route';

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const EXPERIMENT_ID = 'exp-1';

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/admin/orchestration/experiments/${EXPERIMENT_ID}/compare`
  );
}

function ctx() {
  return { params: Promise.resolve({ id: EXPERIMENT_ID }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

function makeExperiment(
  overrides: Partial<{
    createdBy: string;
    name: string;
    variants: Array<{
      id: string;
      label: string;
      evaluationRunId: string | null;
      evaluationRun: {
        id: string;
        status: string;
        summary: Record<string, unknown> | null;
      } | null;
    }>;
  }> = {}
) {
  return {
    id: EXPERIMENT_ID,
    name: overrides.name ?? 'A/B refund prompts',
    createdBy: overrides.createdBy ?? ADMIN_ID,
    variants: overrides.variants ?? [
      {
        id: 'v1',
        label: 'Control',
        evaluationRunId: 'run-1',
        evaluationRun: {
          id: 'run-1',
          status: 'completed',
          summary: {
            stats: { faithfulness: { mean: 0.6 }, relevance: { mean: 0.55 } },
            rawScores: {
              faithfulness: [0.5, 0.6, 0.7],
              relevance: [0.4, 0.6, 0.65],
            },
          },
        },
      },
      {
        id: 'v2',
        label: 'New prompt',
        evaluationRunId: 'run-2',
        evaluationRun: {
          id: 'run-2',
          status: 'completed',
          summary: {
            stats: { faithfulness: { mean: 0.8 }, relevance: { mean: 0.75 } },
            rawScores: {
              faithfulness: [0.7, 0.8, 0.9],
              relevance: [0.7, 0.75, 0.8],
            },
          },
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /experiments/:id/compare — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(403);
  });
});

describe('GET /experiments/:id/compare — ownership + not-found', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 404 when the experiment does not exist', async () => {
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(null);
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 404 when another user owns the experiment (no existence leak)', async () => {
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
      makeExperiment({ createdBy: 'someone-else' }) as never
    );
    const res = await GET(makeRequest(), ctx());
    expect(res.status).toBe(404);
  });
});

describe('GET /experiments/:id/compare — happy path', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('projects rawScores + means and unions metric slugs across variants', async () => {
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(makeExperiment() as never);

    const res = await GET(makeRequest(), ctx());

    expect(res.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: {
        experimentName: string;
        metricSlugs: string[];
        variants: Array<{
          label: string;
          rawScores: Record<string, number[]>;
          meanByMetric: Record<string, number>;
        }>;
      };
    }>(res);
    expect(body.success).toBe(true);
    expect(body.data.experimentName).toBe('A/B refund prompts');
    expect(body.data.metricSlugs).toEqual(['faithfulness', 'relevance']);
    expect(body.data.variants[0].rawScores.faithfulness).toEqual([0.5, 0.6, 0.7]);
    expect(body.data.variants[0].meanByMetric.faithfulness).toBeCloseTo(0.6, 3);
    expect(body.data.variants[1].rawScores.relevance).toEqual([0.7, 0.75, 0.8]);
  });

  it('falls back to computed mean when summary.stats is missing', async () => {
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
      makeExperiment({
        variants: [
          {
            id: 'v1',
            label: 'A',
            evaluationRunId: 'r-a',
            evaluationRun: {
              id: 'r-a',
              status: 'completed',
              summary: { rawScores: { groundedness: [0.2, 0.4, 0.6] } },
            },
          },
          {
            id: 'v2',
            label: 'B',
            evaluationRunId: 'r-b',
            evaluationRun: {
              id: 'r-b',
              status: 'completed',
              summary: { rawScores: { groundedness: [0.8, 0.8, 0.9] } },
            },
          },
        ],
      }) as never
    );

    const res = await GET(makeRequest(), ctx());
    const body = await parseJson<{
      data: { variants: Array<{ meanByMetric: Record<string, number> }> };
    }>(res);
    // (0.2 + 0.4 + 0.6) / 3 = 0.4
    expect(body.data.variants[0].meanByMetric.groundedness).toBeCloseTo(0.4, 6);
  });

  it('drops non-numeric and non-array score entries defensively', async () => {
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
      makeExperiment({
        variants: [
          {
            id: 'v1',
            label: 'A',
            evaluationRunId: 'r',
            evaluationRun: {
              id: 'r',
              status: 'completed',
              summary: {
                rawScores: {
                  good: [0.5, 0.6],
                  notarray: 'oops',
                  withjunk: [0.5, 'nope', NaN, 0.7],
                },
              },
            },
          },
          {
            id: 'v2',
            label: 'B',
            evaluationRunId: 'r2',
            evaluationRun: {
              id: 'r2',
              status: 'completed',
              summary: { rawScores: { good: [0.7, 0.8] } },
            },
          },
        ],
      }) as never
    );

    const res = await GET(makeRequest(), ctx());
    const body = await parseJson<{
      data: { metricSlugs: string[]; variants: Array<{ rawScores: Record<string, number[]> }> };
    }>(res);
    expect(body.data.metricSlugs).toContain('good');
    expect(body.data.metricSlugs).not.toContain('notarray');
    expect(body.data.variants[0].rawScores.withjunk).toEqual([0.5, 0.7]);
  });

  it('returns empty rawScores when a variant has no eval run yet', async () => {
    vi.mocked(prisma.aiExperiment.findUnique).mockResolvedValue(
      makeExperiment({
        variants: [
          {
            id: 'v1',
            label: 'A',
            evaluationRunId: null,
            evaluationRun: null,
          },
          {
            id: 'v2',
            label: 'B',
            evaluationRunId: null,
            evaluationRun: null,
          },
        ],
      }) as never
    );

    const res = await GET(makeRequest(), ctx());
    const body = await parseJson<{
      data: {
        metricSlugs: string[];
        variants: Array<{ rawScores: Record<string, number[]>; runStatus: string | null }>;
      };
    }>(res);
    expect(body.data.metricSlugs).toEqual([]);
    expect(body.data.variants[0].rawScores).toEqual({});
    expect(body.data.variants[0].runStatus).toBeNull();
  });
});
