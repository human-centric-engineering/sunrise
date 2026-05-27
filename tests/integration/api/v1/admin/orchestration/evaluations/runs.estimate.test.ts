/**
 * Integration test: POST /api/v1/admin/orchestration/evaluations/runs/estimate
 *
 * Coverage:
 * - 401 / 403 on missing or non-admin session
 * - 400 on malformed body (missing required fields)
 * - 404 when the dataset isn't owned by the caller
 * - 200 happy path returns the EvaluationCostEstimate shape
 * - judgeAgentSlugs defaults to [] when omitted
 * - caseCount override flows through
 *
 * @see app/api/v1/admin/orchestration/evaluations/runs/estimate/route.ts
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
  },
}));

vi.mock('@/lib/orchestration/cost-estimation/evaluation-cost', () => ({
  estimateEvaluationRunCost: vi.fn(),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { estimateEvaluationRunCost } from '@/lib/orchestration/cost-estimation/evaluation-cost';
import { POST } from '@/app/api/v1/admin/orchestration/evaluations/runs/estimate/route';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/evaluations/runs/estimate',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const SAMPLE_ESTIMATE = {
  midUsd: 0.42,
  lowUsd: 0.21,
  highUsd: 0.84,
  basedOn: 'heuristic' as const,
  sampleSize: 0,
  caseCount: 10,
  modelMix: [],
  notes: 'Heuristic estimate from 10 cases.',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /evaluations/runs/estimate — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const res = await POST(makeRequest({ agentId: 'a', datasetId: 'd' }));

    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const res = await POST(makeRequest({ agentId: 'a', datasetId: 'd' }));

    expect(res.status).toBe(403);
  });
});

describe('POST /evaluations/runs/estimate — validation', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('rejects a missing agentId with 400', async () => {
    const res = await POST(makeRequest({ datasetId: 'd' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing datasetId with 400', async () => {
    const res = await POST(makeRequest({ agentId: 'a' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /evaluations/runs/estimate — dataset ownership', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 404 when the dataset is not owned by the caller', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null);

    const res = await POST(makeRequest({ agentId: 'a', datasetId: 'unknown' }));

    expect(res.status).toBe(404);
    expect(vi.mocked(estimateEvaluationRunCost)).not.toHaveBeenCalled();
  });
});

describe('POST /evaluations/runs/estimate — happy path', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: 'ds-1' } as never);
    vi.mocked(estimateEvaluationRunCost).mockResolvedValue(SAMPLE_ESTIMATE);
  });

  it('returns the estimate verbatim under success: true', async () => {
    const res = await POST(
      makeRequest({
        agentId: 'agent-1',
        datasetId: 'ds-1',
        judgeAgentSlugs: ['judge-relevance'],
      })
    );

    expect(res.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: typeof SAMPLE_ESTIMATE }>(res);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(SAMPLE_ESTIMATE);
    expect(vi.mocked(estimateEvaluationRunCost)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        datasetId: 'ds-1',
        judgeAgentSlugs: ['judge-relevance'],
        // Route must thread session.user.id so the empirical past-runs
        // query is user-scoped — see seed-loader.ts for the same fix.
        userId: expect.any(String),
      })
    );
  });

  it('defaults judgeAgentSlugs to [] when omitted', async () => {
    const res = await POST(makeRequest({ agentId: 'agent-1', datasetId: 'ds-1' }));

    expect(res.status).toBe(200);
    expect(vi.mocked(estimateEvaluationRunCost)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        datasetId: 'ds-1',
        judgeAgentSlugs: [],
        userId: expect.any(String),
      })
    );
  });

  it('passes caseCount override through to the estimator', async () => {
    const res = await POST(
      makeRequest({
        agentId: 'agent-1',
        datasetId: 'ds-1',
        caseCount: 7,
      })
    );

    expect(res.status).toBe(200);
    expect(vi.mocked(estimateEvaluationRunCost)).toHaveBeenCalledWith(
      expect.objectContaining({ caseCount: 7 })
    );
  });
});

describe('POST /evaluations/runs/estimate — workflow subjects (Phase 3.5b)', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: 'ds-1' } as never);
    vi.mocked(estimateEvaluationRunCost).mockResolvedValue(SAMPLE_ESTIMATE);
  });

  it('threads subjectKind=workflow + workflowId to the estimator (no agentId)', async () => {
    const res = await POST(
      makeRequest({
        subjectKind: 'workflow',
        workflowId: 'wf-42',
        datasetId: 'ds-1',
      })
    );

    expect(res.status).toBe(200);
    const args = vi.mocked(estimateEvaluationRunCost).mock.calls[0][0];
    expect(args.subjectKind).toBe('workflow');
    expect(args.workflowId).toBe('wf-42');
    expect(args.agentId).toBeUndefined();
  });

  it('rejects subjectKind=workflow without workflowId (Zod refine)', async () => {
    const res = await POST(
      makeRequest({
        subjectKind: 'workflow',
        datasetId: 'ds-1',
      })
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(estimateEvaluationRunCost)).not.toHaveBeenCalled();
  });

  it('rejects subjectKind=agent without agentId (Zod refine)', async () => {
    const res = await POST(
      makeRequest({
        subjectKind: 'agent',
        datasetId: 'ds-1',
      })
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(estimateEvaluationRunCost)).not.toHaveBeenCalled();
  });
});
