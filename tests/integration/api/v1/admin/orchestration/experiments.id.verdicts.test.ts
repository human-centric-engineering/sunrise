/**
 * Integration tests: POST /api/v1/admin/orchestration/experiments/:id/verdicts
 *
 * Coverage:
 * - 401 / 403 on missing or non-admin session
 * - 404 on missing experiment / cross-user access (no existence leak)
 * - 400 on validation (same variant for A + B, missing variantIds,
 *   missing evaluationRunId on a variant, missing dataset, judge agent
 *   not found or wrong kind)
 * - 400 when either variant's run has not completed (queued, running,
 *   failed, cancelled), before any judging or write
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    aiAgent: { findFirst: vi.fn() },
    aiEvaluationCaseResult: { findMany: vi.fn() },
    aiDatasetCase: { findMany: vi.fn() },
    aiDataset: { findFirst: vi.fn() },
    aiEvaluationRun: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
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
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { POST } from '@/app/api/v1/admin/orchestration/experiments/[id]/verdicts/route';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';

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

const DATASET_ID = 'ds-1';

/**
 * The bound dataset, as the route reads it: on its own, through the dataset's
 * visibility (not included, where the owner layer would refuse it before the
 * route could name it). Owner-aware, so a route that dropped the visibility
 * clause would get a foreign dataset back and these tests would see it.
 */
function bindDataset(dataset: { caseCount: number; userId: string | null } | null) {
  vi.mocked(prisma.aiDataset.findFirst).mockImplementation(
    ownerScopedFindFirst(dataset ? [{ id: DATASET_ID, ...dataset }] : []) as never
  );
}

/**
 * Who started each variant's run, and its status. The route reads the caller's
 * own among the two; this fake answers from the table, so a route that stopped
 * asking for `userId` would read another admin's run as its own. Runs not named
 * are the caller's and completed.
 */
function setRuns(runs: Record<string, { userId?: string; status?: string }>) {
  vi.mocked(prisma.aiEvaluationRun.findMany).mockImplementation(((args: {
    where: { id: { in: string[] }; userId: string };
  }) =>
    Promise.resolve(
      args.where.id.in
        .filter((id) => (runs[id]?.userId ?? ADMIN_ID) === args.where.userId)
        .map((id) => ({ id, status: runs[id]?.status ?? 'completed' }))
    )) as never);
}

/**
 * The experiment row. Also binds its dataset (`bindDataset`), since the route
 * reads that separately — pass `dataset: null` for an experiment with none.
 */
function makeExperiment(
  overrides: Partial<{
    createdBy: string | null;
    variants: Array<{ id: string; label: string; evaluationRunId: string | null }>;
    dataset: { caseCount: number; userId: string | null } | null;
  }> = {}
) {
  const dataset =
    overrides.dataset === undefined ? { caseCount: 3, userId: ADMIN_ID } : overrides.dataset;
  bindDataset(dataset);
  return {
    id: EXPERIMENT_ID,
    name: 'Test Experiment',
    // `in` rather than `??`: an explicit null is the ownerless case, and
    // `?? ADMIN_ID` would turn it back into the caller's own id.
    createdBy: 'createdBy' in overrides ? (overrides.createdBy ?? null) : ADMIN_ID,
    datasetId: dataset ? DATASET_ID : null,
    variants: overrides.variants ?? [
      { id: VARIANT_A, label: 'Control', evaluationRunId: 'run-a' },
      { id: VARIANT_B, label: 'Variant', evaluationRunId: 'run-b' },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  limiterCheck.mockReturnValue({ success: true, remaining: 4, reset: Date.now() + 60_000 });
  bindDataset({ caseCount: 3, userId: ADMIN_ID });
  setRuns({});
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
    // Ownership clause and id as separate AND members; under the default
    // policy the ownership member is the widened form — the caller, or nobody.
    expect(vi.mocked(prisma.aiExperiment.findFirst).mock.calls[0][0]).toMatchObject({
      where: {
        AND: [{ OR: [{ createdBy: ADMIN_ID }, { createdBy: null }] }, { id: EXPERIMENT_ID }],
      },
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

  it('refuses an orphan experiment whose variants another admin ran, and keeps the stored verdict', async () => {
    // The orphan is readable to the caller, but variant B's run is another
    // admin's: its results would not come back, and judging nothing would
    // write an empty verdict over the one stored.
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ createdBy: null, dataset: { caseCount: 3, userId: null } }) as never
    );
    setRuns({ 'run-b': { userId: 'another-admin' } });

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(400);
    expect(vi.mocked(prisma.aiEvaluationRun.findMany)).toHaveBeenCalledWith({
      where: { id: { in: ['run-a', 'run-b'] }, userId: ADMIN_ID },
      select: { id: true, status: true },
    });
    expect(vi.mocked(prisma.aiEvaluationCaseResult.findMany)).not.toHaveBeenCalled();
    expect(grade).not.toHaveBeenCalled();
    expect(prisma.aiExperiment.update).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running', 'failed', 'cancelled'])(
    'refuses when a variant run is %s, and keeps the stored verdict',
    async (status) => {
      vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
      setRuns({ 'run-b': { status } });

      const res = await POST(makeRequest(defaultBody()), ctx());

      expect(res.status).toBe(400);
      const body = await parseJson<{
        error: { message: string; details: { runs: Array<{ id: string; status: string }> } };
      }>(res);
      expect(body.error.message).toMatch(/completed/);
      // The unfinished run, not the "run by you" refusal the ownership check gives.
      expect(body.error.message).not.toMatch(/run by you/);
      expect(body.error.details.runs).toEqual([{ id: 'run-b', status }]);
      expect(vi.mocked(prisma.aiEvaluationCaseResult.findMany)).not.toHaveBeenCalled();
      expect(grade).not.toHaveBeenCalled();
      expect(prisma.aiExperiment.update).not.toHaveBeenCalled();
    }
  );

  it('names both runs when neither has completed', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    setRuns({ 'run-a': { status: 'failed' }, 'run-b': { status: 'running' } });

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(400);
    const body = await parseJson<{
      error: { details: { runs: Array<{ id: string; status: string }> } };
    }>(res);
    expect(body.error.details.runs).toEqual([
      { id: 'run-a', status: 'failed' },
      { id: 'run-b', status: 'running' },
    ]);
    expect(prisma.aiExperiment.update).not.toHaveBeenCalled();
  });

  it("gives the ownership refusal, not the status one, for another admin's unfinished run", async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ createdBy: null, dataset: { caseCount: 3, userId: null } }) as never
    );
    setRuns({ 'run-b': { userId: 'another-admin', status: 'running' } });

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(400);
    const body = await parseJson<{ error: { message: string; details?: unknown } }>(res);
    expect(body.error.message).toMatch(/run by you/);
    // Nothing about the other admin's run: not its status, not its id.
    expect(body.error.details).toBeUndefined();
  });

  /**
   * Defence in depth on the BOUND DATASET, not on the experiment — the `where`
   * above settles that. `run` has carried this since t-678; `verdicts` did not
   * until t-687, and it is the member of the family that leaks most without it:
   * the response returns `datasetCase.input` and `expectedOutput` for every
   * case, where `run` only reads the hash and the count.
   *
   * Unreachable through today's routes — `POST /experiments` is the only path
   * that binds a dataset and it enforces `datasetVisibilityWhere`, and the
   * update schema deliberately does not accept `datasetId`. The check exists so
   * a future second create path cannot silently re-open it.
   */
  describe('the bound dataset', () => {
    afterEach(() => {
      __resetAuthorizationPolicyForTests();
    });

    it('404s when the dataset belongs to a different admin', async () => {
      vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
        makeExperiment({ dataset: { caseCount: 3, userId: 'someone-else' } }) as never
      );

      const res = await POST(makeRequest(defaultBody()), ctx());

      expect(res.status).toBe(404);
      // Before the case-count cap, deliberately: that 409 names how many cases
      // the dataset has, which is a fact about a dataset this caller may not
      // read.
      expect(vi.mocked(prisma.aiEvaluationCaseResult.findMany)).not.toHaveBeenCalled();
    });

    it('scores an ownerless dataset when the policy permits unattributed reads', async () => {
      // The control for the case above: same fake, same route, only the owner
      // differs. An erasure orphans the dataset alongside the experiment, and a
      // bare `!== session.user.id` would make a claimed orphan unscoreable
      // (t-678).
      vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
        makeExperiment({ dataset: { caseCount: 3, userId: null } }) as never
      );
      vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
        id: 'judge-1',
        kind: 'judge',
        isActive: true,
      } as never);
      vi.mocked(prisma.aiEvaluationCaseResult.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiExperiment.update).mockResolvedValue({ id: EXPERIMENT_ID } as never);

      const res = await POST(makeRequest(defaultBody()), ctx());

      expect(res.status).toBe(200);
    });

    it('404s that same ownerless dataset under a policy that denies them', async () => {
      // The half that was unreachable before this seam existed: no route code
      // changes, the fork's policy does it.
      registerAuthorizationPolicy({
        ...DEFAULT_AUTHORIZATION_POLICY,
        canRead: (viewer, target, scope) =>
          target.kind === 'unattributed'
            ? Promise.resolve(false)
            : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
      });
      vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
        makeExperiment({ dataset: { caseCount: 3, userId: null } }) as never
      );

      const res = await POST(makeRequest(defaultBody()), ctx());

      expect(res.status).toBe(404);
    });
  });

  it('returns 409 when dataset case count exceeds the 100-case cap', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ dataset: { caseCount: 250, userId: ADMIN_ID } }) as never
    );
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(409);
  });

  it('returns 400 when the judge agent slug does not exist', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(400);
  });

  it("checks a platform judge slug against the org's system instance only (§116 t-725)", async () => {
    // As the grader will load it, so an org's own agent under the slug is
    // refused here rather than accepted and then failing every case.
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);

    const res = await POST(
      makeRequest({ ...defaultBody(), judgeAgentSlug: 'eval-judge-relevance' }),
      ctx()
    );

    expect(res.status).toBe(400);
    expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'eval-judge-relevance', isSystem: true } })
    );
  });

  it('returns 400 when the named agent is not a judge', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      id: 'a',
      kind: 'chat',
      isActive: true,
    } as never);
    const res = await POST(makeRequest(defaultBody()), ctx());
    expect(res.status).toBe(400);
  });
});

/** The cases variant A's results point at, as the visibility-narrowed read returns them. */
function answerCases(): void {
  vi.mocked(prisma.aiDatasetCase.findMany).mockImplementation((async (args: {
    where: { id: { in: string[] } };
  }) =>
    args.where.id.in.map((id) => ({
      id,
      input: `q${id.slice('case-'.length)}`,
      expectedOutput: id === 'case-0' ? 'e0' : null,
      metadata: null,
    }))) as never);
}

describe('POST /experiments/:id/verdicts — happy path', () => {
  beforeEach(() => {
    answerCases();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(makeExperiment() as never);
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
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
          datasetCaseId: 'case-0',
        },
        {
          casePosition: 1,
          subjectOutput: 'A1',
          datasetCaseId: 'case-1',
        },
        {
          casePosition: 2,
          subjectOutput: 'A2',
          datasetCaseId: 'case-2',
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
          datasetCaseId: 'case-0',
        },
        {
          casePosition: 1,
          subjectOutput: 'A1',
          datasetCaseId: 'case-1',
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

  it("reads each variant's results through the caller's runs, and fails a case whose dataset it can no longer see", async () => {
    vi.mocked(prisma.aiEvaluationCaseResult.findMany)
      .mockResolvedValueOnce([
        { casePosition: 0, subjectOutput: 'A0', datasetCaseId: 'case-0' },
        { casePosition: 1, subjectOutput: 'A1', datasetCaseId: 'case-1' },
      ] as never)
      .mockResolvedValueOnce([
        { casePosition: 0, subjectOutput: 'B0' },
        { casePosition: 1, subjectOutput: 'B1' },
      ] as never);
    // Only case 0 comes back through the dataset's visibility.
    vi.mocked(prisma.aiDatasetCase.findMany).mockResolvedValueOnce([
      { id: 'case-0', input: 'q0', expectedOutput: null, metadata: null },
    ] as never);
    grade.mockResolvedValueOnce({ verdict: 'A', reasoning: 'fine' });

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(200);
    for (const [call] of vi.mocked(prisma.aiEvaluationCaseResult.findMany).mock.calls) {
      expect(call?.where).toMatchObject({ run: { userId: ADMIN_ID } });
    }
    const body = await parseJson<{
      data: { casesScored: number; perCase: Array<{ casePosition: number; error?: string }> };
    }>(res);
    expect(body.data.casesScored).toBe(1);
    expect(body.data.perCase.find((c) => c.casePosition === 1)?.error).toBe('missing_dataset_case');
    expect(grade).toHaveBeenCalledTimes(1);
  });

  it('marks unpaired positions as failed without invoking the grader', async () => {
    vi.mocked(prisma.aiEvaluationCaseResult.findMany)
      .mockResolvedValueOnce([
        {
          casePosition: 0,
          subjectOutput: 'A0',
          datasetCaseId: 'case-0',
        },
        {
          casePosition: 1,
          subjectOutput: 'A1',
          datasetCaseId: 'case-1',
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

/**
 * t-687: `experiment.verdict_compute` is a new audit action — the only mutation
 * in this family that recorded nothing at all before — and four documents
 * promise operators will start seeing it. Nothing asserted it existed: this
 * file mocked `logAdminAction` so the route would stop 500ing, and never looked
 * at it, so a route that stopped calling `logExperimentAccess` stayed green
 * while the docs kept promising the row.
 *
 * Unlike the two read actions, this one is `record: 'always'` — a write, logged
 * whoever makes it — so the owner case is the positive one here rather than the
 * silent one.
 */
describe('audit — a verdict overwrite leaves a record whoever made it', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      id: 'a',
      kind: 'judge',
      isActive: true,
    } as never);
    vi.mocked(prisma.aiEvaluationCaseResult.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue({ id: EXPERIMENT_ID } as never);
  });

  it("records the owner's own verdict run, carrying the basis", async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ createdBy: ADMIN_ID }) as never
    );

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(200);
    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'experiment.verdict_compute',
        entityType: 'experiment',
        entityId: EXPERIMENT_ID,
        metadata: expect.objectContaining({ accessBasis: 'owner' }),
      })
    );
  });

  it('marks the same run against an orphan as such', async () => {
    vi.mocked(prisma.aiExperiment.findFirst).mockResolvedValue(
      makeExperiment({ createdBy: null, dataset: { caseCount: 3, userId: null } }) as never
    );

    const res = await POST(makeRequest(defaultBody()), ctx());

    expect(res.status).toBe(200);
    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'experiment.verdict_compute',
        metadata: expect.objectContaining({ accessBasis: 'orphan' }),
      })
    );
  });
});
