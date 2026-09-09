/**
 * Integration tests: POST /api/v1/admin/orchestration/experiments/:id/verdicts
 *
 * Coverage:
 * - 401 / 403 on missing or non-admin session
 * - 404 on missing experiment / cross-user access (no existence leak)
 * - 400 on validation (same variant for A + B, missing variantIds,
 *   missing evaluationRunId on a variant, missing dataset, judge agent
 *   not found or wrong kind)
 * - 409 when dataset case count exceeds the synchronous cap
 * - 200 happy path: tallies A / B / tie verdicts from the (mocked)
 *   grader, persists summary on AiExperiment.pairwiseVerdict
 * - Missing-pair handling: positions present in one variant but not the
 *   other are recorded as failures with an `error` string
 * - Judge-error handling: grader-prefixed reasoning counts toward
 *   `casesFailed`, not the {A, B, tie} tally
 *
 * @see app/api/v1/admin/orchestration/experiments/[id]/verdicts/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { ownerScopedFindFirst } from '@/tests/helpers/owner-scoped-prisma';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiExperiment: { findFirst: vi.fn(), update: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
    aiEvaluationCaseResult: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// vi.mock factories are hoisted; any variables they reference must also
// be hoisted via vi.hoisted(), otherwise they're undefined at factory time.
const { limiterCheck, grade } = vi.hoisted(() => ({
  limiterCheck: vi.fn(),
  grade: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
    '@/lib/security/rate-limit'
  );
  return {
    ...actual,
    pairwiseVerdictLimiter: { check: limiterCheck },
  };
});

vi.mock('@/lib/orchestration/evaluations/graders/pairwise/judge-agent', () => ({
  pairwiseJudgeAgentGrader: {
    slug: 'pairwise_judge_agent',
    family: 'pairwise',
    grade,
  },
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { POST } from '@/app/api/v1/admin/orchestration/experiments/[id]/verdicts/route';

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const EXPERIMENT_ID = 'exp-1';
const VARIANT_A = 'v-a';
const VARIANT_B = 'v-b';
const JUDGE_SLUG = 'eval-judge-correctness';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/admin/orchestration/experiments/${EXPERIMENT_ID}/verdicts`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function ctx() {
  return { params: Promise.resolve({ id: EXPERIMENT_ID }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

function defaultBody(
  overrides: Partial<{ judgeAgentSlug: string; variantAId: string; variantBId: string }> = {}
) {
  return {
    judgeAgentSlug: JUDGE_SLUG,
    variantAId: VARIANT_A,
    variantBId: VARIANT_B,
    ...overrides,
  };
}

function makeExperiment(
  overrides: Partial<{
    createdBy: string;
    variants: Array<{ id: string; label: string; evaluationRunId: string | null }>;
    dataset: { caseCount: number } | null;
  }> = {}
) {
  return {
    id: EXPERIMENT_ID,
    createdBy: overrides.createdBy ?? ADMIN_ID,
    datasetId: 'ds-1',
    variants: overrides.variants ?? [
      { id: VARIANT_A, label: 'Control', evaluationRunId: 'run-a' },
      { id: VARIANT_B, label: 'Variant', evaluationRunId: 'run-b' },
    ],
    dataset: overrides.dataset === undefined ? { caseCount: 3 } : overrides.dataset,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  limiterCheck.mockReturnValue({ success: true, remaining: 4, reset: Date.now() + 60_000 });
});

describe('POST /experiments/:id/verdicts — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(403);
  });
});

describe('POST /experiments/:id/verdicts — ownership + validation', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 404 when the experiment does not exist', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(null);
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 404 when another user owns the experiment (no existence leak)', async () => {
    // Owner-aware fake, not `mockResolvedValue`: the route has to ASK for its
    // own rows to get one back, so dropping the `createdBy` clause fails here.
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst([makeExperiment({ createdBy: 'someone-else' })]) as never
    );

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(404);
    expect(vi.mocked(prisma.aiExperiment.findFirst).mock.calls[0][0]).toMatchObject({
      where: { id: EXPERIMENT_ID, createdBy: ADMIN_ID },
    });
    expect(prisma.aiExperiment.update).not.toHaveBeenCalled();
  });

  it('returns 400 when variantAId === variantBId', async () => {
    const res = await POST(makeRequest(defaultBody({ variantBId: VARIANT_A })), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 400 when a variantId does not belong to the experiment', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    const res = await POST(makeRequest(defaultBody({ variantBId: 'not-on-experiment' })), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 400 when a variant has no evaluationRunId yet', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({
        variants: [
          { id: VARIANT_A, label: 'A', evaluationRunId: 'run-a' },
          { id: VARIANT_B, label: 'B', evaluationRunId: null },
        ],
      }) as never
    );
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 400 when the experiment has no dataset', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ dataset: null }) as never
    );
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 409 when dataset case count exceeds the 100-case cap', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ dataset: { caseCount: 250 } }) as never
    );
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(409);
  });

  it('returns 400 when the judge agent slug does not exist', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 400 when the named agent is not a judge', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: 'a',
      kind: 'chat',
      isActive: true,
    } as never);
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(400);
  });
});

describe('POST /experiments/:id/verdicts — happy path', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: 'a',
      kind: 'judge',
      isActive: true,
    } as never);
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue({ id: EXPERIMENT_ID } as never);
  });

  it('tallies A / B / tie verdicts and persists the summary', async () => {
    vi.mocked(prisma.aiEvaluationCaseResult.findMany)
      .mockResolvedValueOnce([
        {
          casePosition: 0,
          subjectOutput: 'A0',
          datasetCase: { input: 'q0', expectedOutput: 'e0' },
        },
        {
          casePosition: 1,
          subjectOutput: 'A1',
          datasetCase: { input: 'q1', expectedOutput: null },
        },
        {
          casePosition: 2,
          subjectOutput: 'A2',
          datasetCase: { input: 'q2', expectedOutput: null },
        },
      ] as never)
      .mockResolvedValueOnce([
        { casePosition: 0, subjectOutput: 'B0' },
        { casePosition: 1, subjectOutput: 'B1' },
        { casePosition: 2, subjectOutput: 'B2' },
      ] as never);

    grade
      .mockResolvedValueOnce({ verdict: 'A', reasoning: 'A is clearer' })
      .mockResolvedValueOnce({ verdict: 'B', reasoning: 'B is more correct' })
      .mockResolvedValueOnce({ verdict: 'tie', reasoning: 'roughly equivalent' });

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: {
        judgeAgentSlug: string;
        casesScored: number;
        casesFailed: number;
        counts: { A: number; B: number; tie: number };
        perCase: Array<{ casePosition: number; verdict: string }>;
      };
    }>(res);
    expect(body.success).toBe(true);
    expect(body.data.casesScored).toBe(3);
    expect(body.data.casesFailed).toBe(0);
    expect(body.data.counts).toEqual({ A: 1, B: 1, tie: 1 });
    expect(body.data.perCase.map((c) => c.casePosition)).toEqual([0, 1, 2]);

    expect(prisma.aiExperiment.update).toHaveBeenCalledOnce();
    const updateArg = vi.mocked(prisma.aiExperiment.update).mock.calls[0][0];
    expect(updateArg.where.id).toBe(EXPERIMENT_ID);
    expect(
      (updateArg.data as { pairwiseVerdict: { counts: typeof body.data.counts } }).pairwiseVerdict
        .counts
    ).toEqual({
      A: 1,
      B: 1,
      tie: 1,
    });
  });

  it('counts grader-error reasoning toward casesFailed, not the tally', async () => {
    vi.mocked(prisma.aiEvaluationCaseResult.findMany)
      .mockResolvedValueOnce([
        {
          casePosition: 0,
          subjectOutput: 'A0',
          datasetCase: { input: 'q0', expectedOutput: null },
        },
        {
          casePosition: 1,
          subjectOutput: 'A1',
          datasetCase: { input: 'q1', expectedOutput: null },
        },
      ] as never)
      .mockResolvedValueOnce([
        { casePosition: 0, subjectOutput: 'B0' },
        { casePosition: 1, subjectOutput: 'B1' },
      ] as never);

    grade.mockResolvedValueOnce({ verdict: 'A', reasoning: 'clear winner' }).mockResolvedValueOnce({
      verdict: 'tie',
      reasoning: 'pairwise_judge_agent error: stream_failed',
    });

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(200);
    const body = await parseJson<{
      data: {
        casesScored: number;
        casesFailed: number;
        counts: { A: number; B: number; tie: number };
      };
    }>(res);
    expect(body.data.casesScored).toBe(1);
    expect(body.data.casesFailed).toBe(1);
    expect(body.data.counts).toEqual({ A: 1, B: 0, tie: 0 });
  });

  it('marks unpaired positions as failed without invoking the grader', async () => {
    vi.mocked(prisma.aiEvaluationCaseResult.findMany)
      .mockResolvedValueOnce([
        {
          casePosition: 0,
          subjectOutput: 'A0',
          datasetCase: { input: 'q0', expectedOutput: null },
        },
        {
          casePosition: 1,
          subjectOutput: 'A1',
          datasetCase: { input: 'q1', expectedOutput: null },
        },
      ] as never)
      .mockResolvedValueOnce([
        { casePosition: 0, subjectOutput: 'B0' },
        // No position 1 — should be flagged missing
        { casePosition: 2, subjectOutput: 'B2' }, // No position 0/1 match in A→ wait, 0 matches
      ] as never);

    grade.mockResolvedValueOnce({ verdict: 'A', reasoning: 'fine' });

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(200);
    const body = await parseJson<{
      data: {
        casesScored: number;
        casesFailed: number;
        counts: { A: number; B: number; tie: number };
        perCase: Array<{ casePosition: number; verdict: string; error?: string }>;
      };
    }>(res);
    expect(body.data.casesScored).toBe(1);
    expect(body.data.casesFailed).toBe(2);
    expect(grade).toHaveBeenCalledTimes(1);
    const errors = body.data.perCase.filter((c) => c.error);
    expect(errors.length).toBe(2);
  });
});

describe('POST /experiments/:id/verdicts — rate limit', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 429 when the per-flow limiter rejects', async () => {
    limiterCheck.mockReturnValueOnce({ success: false, remaining: 0, reset: Date.now() + 1000 });
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(429);
  });
});
