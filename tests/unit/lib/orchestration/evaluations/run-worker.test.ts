/**
 * Unit tests for processPendingEvaluationRuns — the evaluation worker.
 *
 * Mocks at the module boundary:
 *   - prisma (aiDatasetCase, aiEvaluationCaseResult, aiAgent, aiEvaluationRun)
 *   - claimNextRun / markTerminal / releaseLease
 *   - hashDatasetCases
 *   - runAgentCase / runWorkflowCase
 *   - getGrader (registry) + logCost
 *
 * Covers:
 *   - returns zeroed result when no claim is available
 *   - happy path (agent subject, 3 cases × 2 metrics → 6 grade calls → completion)
 *   - hash mismatch → mark failed with `dataset_changed_post_submit`
 *   - invalid metric configs → mark failed
 *   - pre-flight fail (reference-required grader, missing expectedOutput) → mark failed
 *   - unknown subjectKind → mark failed
 *   - agent missing → mark failed (no agentId OR agent row deleted)
 *   - subject error → metric scores recorded as null with skip reason
 *   - grader throws → metric recorded as `Grader threw: …`
 *   - metricKey resolution (judge_agent → config.agentSlug; others → slug)
 *   - time-budget release returns 'released' outcome and releases the lease
 *   - worker exception → caught and run marked failed
 *   - workflow subject path (delegates to runWorkflowCase, records errorCode)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { CostOperation } from '@/types/orchestration';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiDatasetCase: { findMany: vi.fn() },
    aiEvaluationCaseResult: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
    aiEvaluationRun: { update: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/evaluations/run-claim', () => ({
  claimNextRun: vi.fn(),
  markTerminal: vi.fn(),
  releaseLease: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/datasets/hash', () => ({
  hashDatasetCases: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/run-cases/agent-case', () => ({
  runAgentCase: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/run-cases/workflow-case', () => ({
  runWorkflowCase: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/graders', () => ({
  getGrader: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat/context-builder', () => ({
  invalidateContext: vi.fn(),
}));

// The fork seam, emptied: these cases register their own hooks, and a fork that
// fills the real one must not change what they assert.
vi.mock('@/lib/app/evaluations', () => ({
  initAppGraders: vi.fn(),
  initAppEvalCaseHooks: vi.fn(),
}));

const { prisma } = await import('@/lib/db/client');
const { claimNextRun, markTerminal, releaseLease } =
  await import('@/lib/orchestration/evaluations/run-claim');
const { hashDatasetCases } = await import('@/lib/orchestration/evaluations/datasets/hash');
const { runAgentCase } = await import('@/lib/orchestration/evaluations/run-cases/agent-case');
const { runWorkflowCase } = await import('@/lib/orchestration/evaluations/run-cases/workflow-case');
const { getGrader } = await import('@/lib/orchestration/evaluations/graders');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { processPendingEvaluationRuns } = await import('@/lib/orchestration/evaluations/run-worker');
const { registerEvalCaseHooks, __resetEvalCaseHooksForTests } =
  await import('@/lib/orchestration/evaluations/case-hooks');
const { invalidateContext } = await import('@/lib/orchestration/chat/context-builder');

const mockedClaim = claimNextRun as unknown as ReturnType<typeof vi.fn>;
const mockedMarkTerminal = markTerminal as unknown as ReturnType<typeof vi.fn>;
const mockedReleaseLease = releaseLease as unknown as ReturnType<typeof vi.fn>;
const mockedHash = hashDatasetCases as unknown as ReturnType<typeof vi.fn>;
const mockedRunAgent = runAgentCase as unknown as ReturnType<typeof vi.fn>;
const mockedRunWorkflow = runWorkflowCase as unknown as ReturnType<typeof vi.fn>;
const mockedGetGrader = getGrader as unknown as ReturnType<typeof vi.fn>;
const mockedLogCost = logCost as unknown as ReturnType<typeof vi.fn>;

const findManyCases = prisma.aiDatasetCase.findMany as unknown as ReturnType<typeof vi.fn>;
const findManyResults = prisma.aiEvaluationCaseResult.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const createResult = prisma.aiEvaluationCaseResult.create as unknown as ReturnType<typeof vi.fn>;
const countResults = prisma.aiEvaluationCaseResult.count as unknown as ReturnType<typeof vi.fn>;
const findAgent = prisma.aiAgent.findUnique as unknown as ReturnType<typeof vi.fn>;
const updateRun = prisma.aiEvaluationRun.update as unknown as ReturnType<typeof vi.fn>;
const findRunStatus = prisma.aiEvaluationRun.findUnique as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    userId: 'user-1',
    name: 'Run 1',
    subjectKind: 'agent',
    agentId: 'agent-1',
    workflowId: null,
    datasetId: 'dataset-1',
    datasetContentHash: 'HASH_OK',
    metricConfigs: [{ slug: 'exact_match', config: {} }],
    judgeProvider: null,
    judgeModel: null,
    subjectOutputSelector: null,
    progress: null,
    parentRunId: null,
    status: 'running',
    startedAt: new Date(),
    ...overrides,
  };
}

function makeCase(position: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `case-${position}`,
    datasetId: 'dataset-1',
    position,
    input: `Question ${position}?`,
    expectedOutput: `Answer ${position}`,
    referenceCitations: null,
    metadata: null,
    ...overrides,
  };
}

function passingGrader(
  overrides: Partial<{
    family: 'heuristic' | 'model';
    referenceRequired: boolean;
    result: Record<string, unknown>;
  }> = {}
) {
  return {
    slug: 'exact_match',
    family: overrides.family ?? 'heuristic',
    referenceRequired: overrides.referenceRequired ?? false,
    configSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
    defaultConfig: {},
    grade: vi.fn(async () => overrides.result ?? { score: 1, passed: true, reasoning: 'ok' }),
    description: 'd',
  };
}

function drainOk(overrides: Record<string, unknown> = {}) {
  return {
    assistantText: 'subject says hi',
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 10, output: 5 },
    costUsd: 0.001,
    latencyMs: 25,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetEvalCaseHooksForTests();
  // Sensible defaults — individual tests override what they care about.
  mockedHash.mockReturnValue('HASH_OK');
  countResults.mockResolvedValue(0);
  updateRun.mockResolvedValue({});
  createResult.mockResolvedValue({});
  findManyResults.mockResolvedValue([]); // no existing case results
  mockedLogCost.mockResolvedValue({ id: 'cost-1' });
  // Default: the per-case status re-read returns 'running' so the loop
  // proceeds. Tests that exercise the cancel-mid-loop path override this.
  findRunStatus.mockResolvedValue({ status: 'running' });
  // markTerminal returns true (the guard predicate matched) by default.
  // The cancel-race regression test overrides to return false.
  mockedMarkTerminal.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Empty-claim short-circuit
// ---------------------------------------------------------------------------

describe('processPendingEvaluationRuns — no claim', () => {
  it('returns zeroed summary when claimNextRun returns null', async () => {
    mockedClaim.mockResolvedValueOnce(null);

    const result = await processPendingEvaluationRuns();

    expect(result).toEqual({ claimed: 0, completed: 0, released: 0, failed: 0, cancelled: 0 });
    expect(findManyCases).not.toHaveBeenCalled();
    expect(mockedMarkTerminal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('processPendingEvaluationRuns — happy path', () => {
  it('drains 3 cases × 2 metrics, writes case results, aggregates, completes', async () => {
    const run = makeRun({
      metricConfigs: [
        { slug: 'exact_match', config: {} },
        { slug: 'contains', config: { needle: 'hi' } },
      ],
    });
    mockedClaim.mockResolvedValueOnce(run);

    findManyCases.mockResolvedValueOnce([makeCase(1), makeCase(2), makeCase(3)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });

    mockedRunAgent.mockResolvedValue(drainOk());

    const exact = passingGrader();
    const contains = passingGrader();
    contains.slug = 'contains';
    mockedGetGrader.mockImplementation((slug: string) => (slug === 'contains' ? contains : exact));

    // The first findMany is the resume cursor (nothing done yet); the
    // second, after all cases are written, returns the rows used for
    // aggregate stats. Each row carries metricScores with both keys.
    findManyResults.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        metricScores: {
          exact_match: { score: 1, passed: true },
          contains: { score: 0.8, passed: true },
        },
        subjectMetadata: {},
        costUsd: 0.001,
      },
      {
        metricScores: {
          exact_match: { score: 0.5, passed: false },
          contains: { score: 1, passed: true },
        },
        subjectMetadata: {},
        costUsd: 0.001,
      },
      {
        metricScores: {
          exact_match: { score: 1, passed: true },
          contains: { score: 1, passed: true },
        },
        subjectMetadata: {},
        costUsd: 0.001,
      },
    ]);

    const result = await processPendingEvaluationRuns();

    expect(result).toEqual({ claimed: 1, completed: 1, released: 0, failed: 0, cancelled: 0 });

    // 3 cases × 2 graders = 6 grade calls
    expect(exact.grade).toHaveBeenCalledTimes(3);
    expect(contains.grade).toHaveBeenCalledTimes(3);

    // 3 case-result rows created
    expect(createResult).toHaveBeenCalledTimes(3);

    // markTerminal('completed', { summary, totalCostUsd })
    const markCall = mockedMarkTerminal.mock.calls[0];
    expect(markCall[0]).toBe('run-1');
    expect(markCall[1]).toBe('completed');
    expect(markCall[2]).toMatchObject({
      summary: expect.objectContaining({
        metricSlugs: ['exact_match', 'contains'],
        stats: expect.any(Object),
      }),
      totalCostUsd: expect.any(Number),
    });

    // Cost rollup logged
    expect(mockedLogCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: CostOperation.EVALUATION_BATCH,
        provider: 'n/a',
        agentId: 'agent-1',
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Terminal status when cases error
// ---------------------------------------------------------------------------

describe('processPendingEvaluationRuns — case failures', () => {
  function setupRun(caseCount: number) {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce(
      Array.from({ length: caseCount }, (_, i) => makeCase(i + 1))
    );
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedGetGrader.mockReturnValue(passingGrader());
    mockedRunAgent.mockResolvedValue(drainOk());
  }

  const failedRow = (errorCode: string) => ({
    metricScores: { exact_match: { score: null } },
    subjectMetadata: {},
    costUsd: 0,
    errorCode,
  });
  const okRow = {
    metricScores: { exact_match: { score: 1, passed: true } },
    subjectMetadata: {},
    costUsd: 0,
    errorCode: null,
  };

  it('marks the run failed, naming the dominant error code, when every case errored', async () => {
    setupRun(3);
    findManyResults
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        failedRow('no_provider_configured'),
        failedRow('no_provider_configured'),
        failedRow('timeout'),
      ]);

    const result = await processPendingEvaluationRuns();

    expect(result).toEqual({ claimed: 1, completed: 0, released: 0, failed: 1, cancelled: 0 });
    const markCall = mockedMarkTerminal.mock.calls[0];
    expect(markCall[1]).toBe('failed');
    expect(markCall[2].summary).toMatchObject({
      note: 'all_cases_failed',
      casesFailed: 3,
      dominantErrorCode: 'no_provider_configured',
    });
    expect(markCall[2].summary.stats.exact_match.scoredCount).toBe(0);
    // The attempts were paid for, so the rollup cost marker is still logged.
    expect(mockedLogCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: CostOperation.EVALUATION_BATCH,
        metadata: expect.objectContaining({ evaluationRunId: 'run-1', phase: 'rollup' }),
      })
    );
  });

  it('breaks a tie on error code alphabetically, whatever order the rows come back in', async () => {
    setupRun(2);
    findManyResults
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failedRow('timeout'), failedRow('no_provider_configured')]);

    await processPendingEvaluationRuns();

    expect(mockedMarkTerminal.mock.calls[0][2].summary).toMatchObject({
      note: 'all_cases_failed',
      dominantErrorCode: 'no_provider_configured',
    });
  });

  // The subject ran, so no case carries an errorCode, but every grader threw:
  // nothing was scored, and the run must not read as a clean result (#921).
  const unscoredRow = {
    metricScores: { exact_match: { score: null, reasoning: 'Grader threw: judge meltdown' } },
    subjectMetadata: {},
    costUsd: 0.001,
    errorCode: null,
  };

  it('marks the run failed with no_scores_recorded when no grader scored any case', async () => {
    setupRun(2);
    findManyResults.mockResolvedValueOnce([]).mockResolvedValueOnce([unscoredRow, unscoredRow]);

    const result = await processPendingEvaluationRuns();

    expect(result).toEqual({ claimed: 1, completed: 0, released: 0, failed: 1, cancelled: 0 });
    const markCall = mockedMarkTerminal.mock.calls[0];
    expect(markCall[1]).toBe('failed');
    expect(markCall[2].summary.note).toBe('no_scores_recorded');
    expect(markCall[2].summary.stats.exact_match.scoredCount).toBe(0);
    // The note is the cases-errored one's sibling, not a variant of it.
    expect(markCall[2].summary.casesFailed).toBeUndefined();
  });

  it('marks the run failed with no_scores_recorded when errored and unscored cases mix', async () => {
    setupRun(2);
    findManyResults
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failedRow('timeout'), unscoredRow]);

    await processPendingEvaluationRuns();

    const markCall = mockedMarkTerminal.mock.calls[0];
    expect(markCall[1]).toBe('failed');
    expect(markCall[2].summary).toMatchObject({
      note: 'no_scores_recorded',
      casesFailed: 1,
      dominantErrorCode: 'timeout',
    });
  });

  it('keeps a run completed when one case scored and the rest went unscored', async () => {
    setupRun(2);
    findManyResults.mockResolvedValueOnce([]).mockResolvedValueOnce([unscoredRow, okRow]);

    await processPendingEvaluationRuns();

    const markCall = mockedMarkTerminal.mock.calls[0];
    expect(markCall[1]).toBe('completed');
    expect(markCall[2].summary.note).toBeUndefined();
    expect(markCall[2].summary.stats.exact_match.scoredCount).toBe(1);
  });

  it('keeps a partially failed run completed with no note', async () => {
    setupRun(2);
    findManyResults.mockResolvedValueOnce([]).mockResolvedValueOnce([failedRow('timeout'), okRow]);

    const result = await processPendingEvaluationRuns();

    expect(result).toEqual({ claimed: 1, completed: 1, released: 0, failed: 0, cancelled: 0 });
    const markCall = mockedMarkTerminal.mock.calls[0];
    expect(markCall[1]).toBe('completed');
    expect(markCall[2].summary.note).toBeUndefined();
    expect(markCall[2].summary.dominantErrorCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hash-pin mismatch
// ---------------------------------------------------------------------------

describe('hash mismatch', () => {
  it('marks run failed with dataset_changed_post_submit on hash mismatch', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun({ datasetContentHash: 'HASH_OLD' }));
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    mockedHash.mockReturnValueOnce('HASH_NEW');

    const result = await processPendingEvaluationRuns();

    expect(result).toEqual({ claimed: 1, completed: 0, released: 0, failed: 1, cancelled: 0 });
    expect(mockedMarkTerminal).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({
        summary: expect.objectContaining({
          note: 'dataset_changed_post_submit',
          expectedHash: 'HASH_OLD',
          currentHash: 'HASH_NEW',
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid metric configs
// ---------------------------------------------------------------------------

describe('metric config validation', () => {
  it('marks failed when metricConfigs is not an array', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun({ metricConfigs: 'not-an-array' }));
    findManyCases.mockResolvedValueOnce([makeCase(1)]);

    const result = await processPendingEvaluationRuns();

    expect(result.failed).toBe(1);
    expect(mockedMarkTerminal).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({ summary: { note: 'invalid_metric_configs' } })
    );
  });

  it('marks failed when a metric entry has no slug', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun({ metricConfigs: [{ config: {} }] }));
    findManyCases.mockResolvedValueOnce([makeCase(1)]);

    const result = await processPendingEvaluationRuns();
    expect(result.failed).toBe(1);
    expect(mockedMarkTerminal.mock.calls[0][2]).toMatchObject({
      summary: { note: 'invalid_metric_configs' },
    });
  });

  it('marks failed when a metric entry is a primitive (not object)', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun({ metricConfigs: [42] as unknown[] }));
    findManyCases.mockResolvedValueOnce([makeCase(1)]);

    const result = await processPendingEvaluationRuns();
    expect(result.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

describe('pre-flight', () => {
  it('marks failed when a reference-required grader sees a case without expectedOutput', async () => {
    mockedClaim.mockResolvedValueOnce(
      makeRun({ metricConfigs: [{ slug: 'exact_match', config: {} }] })
    );
    findManyCases.mockResolvedValueOnce([makeCase(1, { expectedOutput: null }), makeCase(2)]);
    const refGrader = passingGrader({ referenceRequired: true });
    mockedGetGrader.mockReturnValue(refGrader);

    const result = await processPendingEvaluationRuns();

    expect(result.failed).toBe(1);
    expect(mockedMarkTerminal).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({
        summary: expect.objectContaining({
          note: 'preflight_failed',
          error: expect.stringContaining('expectedOutput'),
        }),
      })
    );
  });

  it('marks failed when a grader slug is unknown to the registry', async () => {
    mockedClaim.mockResolvedValueOnce(
      makeRun({ metricConfigs: [{ slug: 'no_such_grader', config: {} }] })
    );
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    mockedGetGrader.mockImplementation(() => {
      throw new Error('No grader registered');
    });

    const result = await processPendingEvaluationRuns();
    expect(result.failed).toBe(1);
    expect(mockedMarkTerminal.mock.calls[0][2]).toMatchObject({
      summary: expect.objectContaining({
        note: 'preflight_failed',
        error: expect.stringContaining('no_such_grader'),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Subject resolution
// ---------------------------------------------------------------------------

describe('subject resolution', () => {
  it('marks failed when subjectKind is neither agent nor workflow', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun({ subjectKind: 'mystery' }));
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    mockedGetGrader.mockReturnValue(passingGrader());

    const result = await processPendingEvaluationRuns();

    expect(result.failed).toBe(1);
    expect(mockedMarkTerminal).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({
        summary: expect.objectContaining({
          note: 'unknown_subject_kind',
          subjectKind: 'mystery',
        }),
      })
    );
  });

  it('marks failed when subjectKind=agent but agentId is null', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun({ agentId: null }));
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    mockedGetGrader.mockReturnValue(passingGrader());

    const result = await processPendingEvaluationRuns();

    expect(result.failed).toBe(1);
    expect(mockedMarkTerminal.mock.calls[0][2]).toMatchObject({
      summary: { note: 'agent_missing_for_agent_subject' },
    });
  });

  it('marks failed when the agent row has been deleted', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun({ agentId: 'agent-gone' }));
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    mockedGetGrader.mockReturnValue(passingGrader());
    findAgent.mockResolvedValueOnce(null);

    const result = await processPendingEvaluationRuns();

    expect(result.failed).toBe(1);
    expect(mockedMarkTerminal.mock.calls[0][2]).toMatchObject({
      summary: expect.objectContaining({ note: 'agent_deleted', agentId: 'agent-gone' }),
    });
  });
});

// ---------------------------------------------------------------------------
// Per-case error handling
// ---------------------------------------------------------------------------

describe('per-case error handling', () => {
  it('records null score with skip reason when the subject returned an errorCode', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    const grader = passingGrader();
    mockedGetGrader.mockReturnValue(grader);
    mockedRunAgent.mockResolvedValueOnce(
      drainOk({
        errorCode: 'budget_exceeded_per_turn',
        errorMessage: 'too expensive',
        assistantText: '',
      })
    );
    findManyResults.mockResolvedValueOnce([
      { metricScores: { exact_match: { score: null } }, subjectMetadata: {}, costUsd: 0 },
    ]);

    await processPendingEvaluationRuns();

    // grader.grade should never have run — subject error short-circuits.
    expect(grader.grade).not.toHaveBeenCalled();

    // The persisted case-result row carries the error code and a metric
    // score of null with a "Skipped" reason.
    const createCall = createResult.mock.calls[0][0];
    expect(createCall.data.errorCode).toBe('budget_exceeded_per_turn');
    expect(createCall.data.errorMessage).toBe('too expensive');
    expect(createCall.data.metricScores).toMatchObject({
      exact_match: expect.objectContaining({
        score: null,
        reasoning: expect.stringMatching(/Skipped.*subject execution failed/),
      }),
    });
  });

  it('records `Grader threw: …` when the grader callback rejects', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedRunAgent.mockResolvedValueOnce(drainOk());

    const broken = passingGrader();
    broken.grade = vi.fn(async () => {
      throw new Error('judge meltdown');
    });
    mockedGetGrader.mockReturnValue(broken);

    findManyResults.mockResolvedValueOnce([
      { metricScores: { exact_match: { score: null } }, subjectMetadata: {}, costUsd: 0.001 },
    ]);

    await processPendingEvaluationRuns();

    const createCall = createResult.mock.calls[0][0];
    expect(createCall.data.metricScores).toMatchObject({
      exact_match: expect.objectContaining({
        score: null,
        reasoning: expect.stringContaining('Grader threw: judge meltdown'),
      }),
    });
  });

  it('records `invalid config` and skips grade when configSchema fails', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedRunAgent.mockResolvedValueOnce(drainOk());

    const grader = passingGrader();
    grader.configSchema = {
      safeParse: vi.fn(() => ({
        success: false,
        error: { issues: [{ message: 'pattern required' }] },
      })),
    } as unknown as typeof grader.configSchema;
    mockedGetGrader.mockReturnValue(grader);

    findManyResults.mockResolvedValueOnce([
      { metricScores: { exact_match: { score: null } }, subjectMetadata: {}, costUsd: 0.001 },
    ]);

    await processPendingEvaluationRuns();

    expect(grader.grade).not.toHaveBeenCalled();
    const createCall = createResult.mock.calls[0][0];
    expect(createCall.data.metricScores).toMatchObject({
      exact_match: expect.objectContaining({
        score: null,
        reasoning: expect.stringContaining('invalid config'),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// metricKey resolution
// ---------------------------------------------------------------------------

describe('metricKey', () => {
  it('uses config.agentSlug as the storage key for judge_agent', async () => {
    mockedClaim.mockResolvedValueOnce(
      makeRun({
        metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'faithfulness-judge' } }],
      })
    );
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedRunAgent.mockResolvedValueOnce(drainOk());

    const grader = passingGrader({ family: 'model' });
    grader.slug = 'judge_agent';
    grader.grade = vi.fn(async () => ({
      score: 0.9,
      passed: true,
      reasoning: 'good',
      costUsd: 0.002,
    }));
    mockedGetGrader.mockReturnValue(grader);

    findManyResults.mockResolvedValueOnce([
      {
        metricScores: { 'faithfulness-judge': { score: 0.9, passed: true } },
        subjectMetadata: {},
        costUsd: 0.003,
      },
    ]);

    await processPendingEvaluationRuns();

    // Stored under the judge slug, NOT under 'judge_agent'
    const createCall = createResult.mock.calls[0][0];
    expect(createCall.data.metricScores).toHaveProperty('faithfulness-judge');
    expect(createCall.data.metricScores).not.toHaveProperty('judge_agent');

    // Summary stats key matches.
    const markCall = mockedMarkTerminal.mock.calls[0];
    expect(markCall[2].summary.metricSlugs).toEqual(['faithfulness-judge']);
  });

  it('falls back to "judge_agent" when judge_agent config has no agentSlug', async () => {
    mockedClaim.mockResolvedValueOnce(
      makeRun({ metricConfigs: [{ slug: 'judge_agent', config: {} }] })
    );
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedRunAgent.mockResolvedValueOnce(drainOk());

    const grader = passingGrader({ family: 'model' });
    grader.slug = 'judge_agent';
    mockedGetGrader.mockReturnValue(grader);

    findManyResults.mockResolvedValueOnce([
      { metricScores: { judge_agent: { score: 1 } }, subjectMetadata: {}, costUsd: 0 },
    ]);

    await processPendingEvaluationRuns();

    const markCall = mockedMarkTerminal.mock.calls[0];
    expect(markCall[2].summary.metricSlugs).toEqual(['judge_agent']);
  });

  it('uses the slug itself as key for heuristic graders', async () => {
    mockedClaim.mockResolvedValueOnce(
      makeRun({ metricConfigs: [{ slug: 'contains', config: { needle: 'hi' } }] })
    );
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedRunAgent.mockResolvedValueOnce(drainOk());

    const grader = passingGrader();
    grader.slug = 'contains';
    mockedGetGrader.mockReturnValue(grader);

    findManyResults.mockResolvedValueOnce([
      { metricScores: { contains: { score: 1, passed: true } }, subjectMetadata: {}, costUsd: 0 },
    ]);

    await processPendingEvaluationRuns();

    expect(createResult.mock.calls[0][0].data.metricScores).toHaveProperty('contains');
  });
});

// ---------------------------------------------------------------------------
// Time-budget release
// ---------------------------------------------------------------------------

describe('time-budget release', () => {
  it('returns released, calls releaseLease, when the case loop exceeds the time budget', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1), makeCase(2), makeCase(3)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedGetGrader.mockReturnValue(passingGrader());

    // Drive Date.now to leap past the 45s budget on the second loop check.
    const nowSpy = vi.spyOn(Date, 'now');
    let call = 0;
    nowSpy.mockImplementation(() => {
      call++;
      // Roughly: every other call is inside the loop's `Date.now() - tickStart > BUDGET` check.
      // Returning a sufficiently large value forces early release.
      if (call <= 3) return 1_000_000;
      return 1_000_000 + 60_000; // > 45s
    });

    mockedRunAgent.mockResolvedValue(drainOk());

    const result = await processPendingEvaluationRuns();

    expect(result.released).toBe(1);
    expect(result.completed).toBe(0);
    expect(mockedReleaseLease).toHaveBeenCalledWith('run-1');
    expect(mockedMarkTerminal).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Cancel race — the regression case from PR #237 review
// ---------------------------------------------------------------------------

describe('cancel-race protection', () => {
  it('breaks out of the case loop when status flips to "cancelled" mid-batch', async () => {
    // Setup: 3 pending cases. The per-case status re-read returns
    // 'running' for the first case, then 'cancelled' before the second.
    // Expected: only one case-result row is written, no markTerminal,
    // no releaseLease, outcome = 'cancelled'.
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1), makeCase(2), makeCase(3)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedGetGrader.mockReturnValue(passingGrader());
    mockedRunAgent.mockResolvedValue(drainOk());

    findRunStatus
      .mockReset()
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'cancelled' });

    const result = await processPendingEvaluationRuns();

    expect(result).toEqual({ claimed: 1, completed: 0, released: 0, failed: 0, cancelled: 1 });
    expect(createResult).toHaveBeenCalledTimes(1);
    expect(mockedMarkTerminal).not.toHaveBeenCalled();
    expect(mockedReleaseLease).not.toHaveBeenCalled();
  });

  it('breaks out on the first iteration when the row was cancelled before any case ran', async () => {
    // Cancel landed in between claim and the first per-case status read.
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1), makeCase(2)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedGetGrader.mockReturnValue(passingGrader());

    findRunStatus.mockReset().mockResolvedValueOnce({ status: 'cancelled' });

    const result = await processPendingEvaluationRuns();

    expect(result.cancelled).toBe(1);
    expect(createResult).not.toHaveBeenCalled();
    expect(mockedMarkTerminal).not.toHaveBeenCalled();
  });

  it('treats a vanished row (findUnique returns null) as cancelled — defensive', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedGetGrader.mockReturnValue(passingGrader());

    findRunStatus.mockReset().mockResolvedValueOnce(null);

    const result = await processPendingEvaluationRuns();

    expect(result.cancelled).toBe(1);
    expect(createResult).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Worker-level crash safety
// ---------------------------------------------------------------------------

describe('worker exception safety', () => {
  it('catches exceptions from driveRun and marks the claimed run failed', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    // Force the very first prisma call inside driveRun to throw.
    findManyCases.mockRejectedValueOnce(new Error('db down'));

    const result = await processPendingEvaluationRuns();

    expect(result).toEqual({ claimed: 1, completed: 0, released: 0, failed: 1, cancelled: 0 });
    expect(mockedMarkTerminal).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({
        summary: expect.objectContaining({ error: 'worker_unexpected_error' }),
      })
    );
  });

  it('does not throw even when markTerminal also fails in the catch-of-catch path', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockRejectedValueOnce(new Error('initial db error'));
    mockedMarkTerminal.mockRejectedValueOnce(new Error('mark also failed'));

    const result = await processPendingEvaluationRuns();

    expect(result.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Workflow subject path
// ---------------------------------------------------------------------------

describe('workflow subject', () => {
  it('dispatches to runWorkflowCase for subjectKind=workflow and records returned errorCode', async () => {
    mockedClaim.mockResolvedValueOnce(
      makeRun({ subjectKind: 'workflow', agentId: null, workflowId: 'wf-1' })
    );
    findManyCases.mockResolvedValueOnce([makeCase(1, { input: { foo: 'bar' } })]);
    mockedGetGrader.mockReturnValue(passingGrader());
    mockedRunWorkflow.mockResolvedValueOnce({
      assistantText: '',
      citations: [],
      toolCalls: [],
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
      latencyMs: 0,
      errorCode: 'workflow_subject_not_supported_in_phase_1',
      errorMessage: 'not supported',
    });
    findManyResults.mockResolvedValueOnce([
      {
        metricScores: { exact_match: { score: null } },
        subjectMetadata: {},
        costUsd: 0,
      },
    ]);

    await processPendingEvaluationRuns();

    expect(mockedRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        userId: 'user-1',
        input: { foo: 'bar' },
      })
    );
    expect(createResult.mock.calls[0][0].data.errorCode).toBe(
      'workflow_subject_not_supported_in_phase_1'
    );
  });

  it('wraps a non-object input in `{ input: value }` for the workflow dispatcher', async () => {
    mockedClaim.mockResolvedValueOnce(
      makeRun({ subjectKind: 'workflow', agentId: null, workflowId: 'wf-1' })
    );
    findManyCases.mockResolvedValueOnce([makeCase(1, { input: 'plain string' })]);
    mockedGetGrader.mockReturnValue(passingGrader());
    mockedRunWorkflow.mockResolvedValueOnce({
      assistantText: '',
      citations: [],
      toolCalls: [],
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
      latencyMs: 0,
    });
    findManyResults.mockResolvedValueOnce([{ metricScores: {}, subjectMetadata: {}, costUsd: 0 }]);

    await processPendingEvaluationRuns();

    expect(mockedRunWorkflow.mock.calls[0][0].input).toEqual({ input: 'plain string' });
  });
});

// ---------------------------------------------------------------------------
// Agent input stringification + progress writes
// ---------------------------------------------------------------------------

describe('progress + input shape', () => {
  it('stringifies non-string case input for the agent subject and grader userInput', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1, { input: { hello: 'world' } })]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });

    const grader = passingGrader();
    mockedGetGrader.mockReturnValue(grader);
    mockedRunAgent.mockResolvedValueOnce(drainOk());
    findManyResults.mockResolvedValueOnce([
      { metricScores: { exact_match: { score: 1 } }, subjectMetadata: {}, costUsd: 0 },
    ]);

    await processPendingEvaluationRuns();

    expect(mockedRunAgent.mock.calls[0][0].message).toBe('{"hello":"world"}');
    const graderMock = grader.grade as unknown as ReturnType<typeof vi.fn>;
    expect(graderMock.mock.calls[0][0].userInput).toBe('{"hello":"world"}');
  });

  it('writes progress at the end of the run (final completion path)', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedGetGrader.mockReturnValue(passingGrader());
    mockedRunAgent.mockResolvedValueOnce(drainOk());
    countResults
      .mockResolvedValueOnce(1) // done count
      .mockResolvedValueOnce(0); // failed count
    findManyResults.mockResolvedValueOnce([
      { metricScores: { exact_match: { score: 1 } }, subjectMetadata: {}, costUsd: 0 },
    ]);

    await processPendingEvaluationRuns();

    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({
          progress: expect.objectContaining({ casesTotal: 1 }),
        }),
      })
    );
  });

  it('skips agent dispatch entirely for cases already in aiEvaluationCaseResult (resume after release)', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([makeCase(1), makeCase(2)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedGetGrader.mockReturnValue(passingGrader());
    mockedRunAgent.mockResolvedValueOnce(drainOk());
    // Pre-existing result for position 1 → only position 2 should run.
    findManyResults.mockResolvedValueOnce([{ casePosition: 1 }]).mockResolvedValueOnce([
      { metricScores: { exact_match: { score: 1 } }, subjectMetadata: {}, costUsd: 0 },
      { metricScores: { exact_match: { score: 1 } }, subjectMetadata: {}, costUsd: 0 },
    ]);

    await processPendingEvaluationRuns();

    expect(mockedRunAgent).toHaveBeenCalledTimes(1);
    expect(createResult).toHaveBeenCalledTimes(1);
    expect(createResult.mock.calls[0][0].data.casePosition).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Aggregation behaviour
// ---------------------------------------------------------------------------

describe('aggregation', () => {
  it('produces null stats for an empty result set', async () => {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce([]); // no cases at all
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedGetGrader.mockReturnValue(passingGrader());
    findManyResults.mockResolvedValueOnce([]);

    await processPendingEvaluationRuns();

    const markCall = mockedMarkTerminal.mock.calls[0];
    expect(markCall[1]).toBe('completed');
    expect(markCall[2].summary.stats.exact_match).toEqual({
      mean: null,
      median: null,
      p95: null,
      passRate: null,
      scoredCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// What a grader sees of the subject's tool calls (#1044, t-986)
// ---------------------------------------------------------------------------

describe('tool outcomes for graders', () => {
  // The trace shape `drainStreamChat` collects from `capability_result` events.
  const searchHit = {
    slug: 'search_knowledge_base',
    arguments: { query: 'filter envelope' },
    latencyMs: 12,
    success: true,
    resultPreview: '{"success":true,"links":["/docs/filter-envelope"]}',
  };
  const searchFailed = {
    slug: 'search_knowledge_base',
    arguments: { query: 'nothing' },
    latencyMs: 9,
    success: false,
    errorCode: 'embedding_unavailable',
  };

  function runOneCase(metricSlug: string, config: Record<string, unknown> = {}) {
    mockedClaim.mockResolvedValueOnce(makeRun({ metricConfigs: [{ slug: metricSlug, config }] }));
    findManyCases.mockResolvedValueOnce([makeCase(1)]);
    findAgent.mockResolvedValueOnce({ slug: 'agent-slug' });
    mockedRunAgent.mockResolvedValueOnce(drainOk({ toolCalls: [searchHit, searchFailed] }));
    findManyResults.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  }

  it('hands each grader whether every call worked and what it returned', async () => {
    const grader = passingGrader();
    mockedGetGrader.mockReturnValue(grader);
    runOneCase('exact_match');

    await processPendingEvaluationRuns();

    expect(grader.grade).toHaveBeenCalledTimes(1);
    const [input] = grader.grade.mock.calls[0] as unknown as [{ toolCalls: unknown }];
    expect(input.toolCalls).toEqual([
      {
        slug: 'search_knowledge_base',
        args: { query: 'filter envelope' },
        success: true,
        resultPreview: '{"success":true,"links":["/docs/filter-envelope"]}',
      },
      {
        slug: 'search_knowledge_base',
        args: { query: 'nothing' },
        success: false,
        errorCode: 'embedding_unavailable',
      },
    ]);
  });

  it('stores the calls as before: slug and args only', async () => {
    mockedGetGrader.mockReturnValue(passingGrader());
    runOneCase('exact_match');

    await processPendingEvaluationRuns();

    expect(createResult.mock.calls[0][0].data.subjectMetadata.toolCalls).toEqual([
      { slug: 'search_knowledge_base', args: { query: 'filter envelope' } },
      { slug: 'search_knowledge_base', args: { query: 'nothing' } },
    ]);
  });

  it('leaves the built-in trajectory grader scoring exactly as it did', async () => {
    const { toolWasCalledGrader } = await vi.importActual<
      typeof import('@/lib/orchestration/evaluations/graders/heuristic/tool-was-called')
    >('@/lib/orchestration/evaluations/graders/heuristic/tool-was-called');
    const spy = vi.spyOn(toolWasCalledGrader, 'grade');
    mockedGetGrader.mockReturnValue(toolWasCalledGrader);
    runOneCase('tool_was_called', { slug: 'search_knowledge_base', min: 2 });

    await processPendingEvaluationRuns();

    // Two calls counted, failed one included, as before the outcome fields.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(createResult.mock.calls[0][0].data.metricScores.tool_was_called).toMatchObject({
      score: 1,
      passed: true,
      reasoning: 'Tool "search_knowledge_base" called 2 time(s) (≥ 2).',
    });
  });
});

// ---------------------------------------------------------------------------
// Per-agent case hooks (#879, t-987)
// ---------------------------------------------------------------------------

describe('case hooks', () => {
  const trace = {
    slug: 'write_bars',
    arguments: { bars: [1, 2] },
    latencyMs: 5,
    success: true,
    resultPreview: '{"written":2}',
  };

  function runCases(cases: ReturnType<typeof makeCase>[]) {
    mockedClaim.mockResolvedValueOnce(makeRun());
    findManyCases.mockResolvedValueOnce(cases);
    findAgent.mockResolvedValueOnce({ slug: 'score-assistant' });
    findManyResults.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  }

  it('runs setup fresh before every case and puts its context on that case’s turn', async () => {
    const setup = vi.fn(({ caseRow }: { caseRow: { position: number } }) => ({
      contextType: 'score',
      contextId: `doc-${caseRow.position}`,
    }));
    registerEvalCaseHooks('score-assistant', { setup });
    mockedRunAgent.mockResolvedValue(drainOk());
    mockedGetGrader.mockReturnValue(passingGrader());
    runCases([makeCase(1), makeCase(2)]);

    await processPendingEvaluationRuns();

    // setup 1, turn 1, setup 2, turn 2: fresh before every case.
    const [setup1, setup2] = setup.mock.invocationCallOrder;
    const [turn1, turn2] = mockedRunAgent.mock.invocationCallOrder;
    expect(setup1 < turn1 && turn1 < setup2 && setup2 < turn2).toBe(true);
    expect(setup.mock.calls[0][0]).toMatchObject({
      agentSlug: 'score-assistant',
      userId: 'user-1',
      runId: 'run-1',
      caseRow: { id: 'case-1', position: 1 },
    });
    expect(mockedRunAgent.mock.calls[0][0].context).toEqual({
      contextType: 'score',
      contextId: 'doc-1',
    });
    expect(mockedRunAgent.mock.calls[1][0].context).toEqual({
      contextType: 'score',
      contextId: 'doc-2',
    });
    // setup may have rewritten what the context names: its cached copy is
    // dropped before the turn reads it.
    expect(vi.mocked(invalidateContext).mock.calls).toEqual([
      ['score', 'doc-1', { userId: 'user-1' }],
      ['score', 'doc-2', { userId: 'user-1' }],
    ]);
    const [invalidated1] = vi.mocked(invalidateContext).mock.invocationCallOrder;
    expect(invalidated1 < turn1).toBe(true);
  });

  it('fails only the case when a hook throws a value that cannot become a string', async () => {
    registerEvalCaseHooks('score-assistant', {
      setup: ({ caseRow }) => {
        if (caseRow.position === 1) throw Object.create(null);
        return null;
      },
    });
    mockedRunAgent.mockResolvedValue(drainOk());
    mockedGetGrader.mockReturnValue(passingGrader());
    runCases([makeCase(1), makeCase(2)]);

    const result = await processPendingEvaluationRuns();

    expect(result.failed).toBe(0);
    const [first, second] = createResult.mock.calls.map((c) => c[0].data);
    expect(first).toMatchObject({
      errorCode: 'case_setup_failed',
      errorMessage: 'a value that cannot be converted to a string',
    });
    // A setup answering null means no context, as undefined does.
    expect(second.errorCode).toBeNull();
    expect(mockedRunAgent.mock.calls[0][0]).not.toHaveProperty('context.contextType');
  });

  it('runs hooks written as a class, with this bound', async () => {
    class ScoreHooks {
      readonly contextId = 'doc-from-class';
      setup() {
        return { contextType: 'score', contextId: this.contextId };
      }
      observe() {
        return { from: this.contextId };
      }
    }
    registerEvalCaseHooks('score-assistant', new ScoreHooks());
    mockedRunAgent.mockResolvedValueOnce(drainOk());
    const grader = passingGrader();
    mockedGetGrader.mockReturnValue(grader);
    runCases([makeCase(1)]);

    await processPendingEvaluationRuns();

    expect(mockedRunAgent.mock.calls[0][0].context).toEqual({
      contextType: 'score',
      contextId: 'doc-from-class',
    });
    const [graded] = grader.grade.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(graded.observed).toEqual({ from: 'doc-from-class' });
  });

  it('observes after the turn, and hands graders the observed state and the case metadata', async () => {
    const observe = vi.fn((_args: unknown) => ({ bars: ['C', 'G'], ghostNotes: 0 }));
    registerEvalCaseHooks('score-assistant', { observe });
    mockedRunAgent.mockResolvedValueOnce(
      drainOk({ toolCalls: [trace], conversationId: 'conv-1', assistantText: 'Done.' })
    );
    const grader = passingGrader();
    mockedGetGrader.mockReturnValue(grader);
    runCases([makeCase(1, { metadata: { startFrom: 'empty-score' } })]);

    await processPendingEvaluationRuns();

    expect(observe.mock.calls[0][0]).toMatchObject({
      caseRow: { id: 'case-1' },
      turn: {
        conversationId: 'conv-1',
        assistantText: 'Done.',
        toolCalls: [
          {
            slug: 'write_bars',
            args: { bars: [1, 2] },
            success: true,
            resultPreview: '{"written":2}',
          },
        ],
      },
    });
    const [graded] = grader.grade.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(graded).toMatchObject({
      caseMetadata: { startFrom: 'empty-score' },
      observed: { bars: ['C', 'G'], ghostNotes: 0 },
    });
    // Passed to graders, never stored.
    expect(JSON.stringify(createResult.mock.calls[0][0].data)).not.toContain('ghostNotes');
  });

  it('fails only the case whose setup throws, and runs the rest', async () => {
    registerEvalCaseHooks('score-assistant', {
      setup: ({ caseRow }) => {
        if (caseRow.position === 1) throw new Error('no such score');
        return undefined;
      },
    });
    mockedRunAgent.mockResolvedValue(drainOk());
    const grader = passingGrader();
    mockedGetGrader.mockReturnValue(grader);
    runCases([makeCase(1), makeCase(2)]);

    await processPendingEvaluationRuns();

    const [first, second] = createResult.mock.calls.map((c) => c[0].data);
    expect(first).toMatchObject({ errorCode: 'case_setup_failed', errorMessage: 'no such score' });
    expect(first.metricScores.exact_match).toMatchObject({ score: null });
    expect(second.errorCode).toBeNull();
    // The failed case never reached the agent; the next one did.
    expect(mockedRunAgent).toHaveBeenCalledTimes(1);
    expect(grader.grade).toHaveBeenCalledTimes(1);
  });

  it('fails the case when setup answers with something that is not a context', async () => {
    registerEvalCaseHooks('score-assistant', {
      setup: () => ({ conversationId: 'c-1' }) as never,
    });
    mockedGetGrader.mockReturnValue(passingGrader());
    runCases([makeCase(1)]);

    await processPendingEvaluationRuns();

    expect(createResult.mock.calls[0][0].data.errorCode).toBe('case_setup_failed');
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it('fails the case when observe throws, and skips its graders', async () => {
    registerEvalCaseHooks('score-assistant', {
      observe: () => {
        throw new Error('score unreadable');
      },
    });
    mockedRunAgent.mockResolvedValueOnce(drainOk());
    const grader = passingGrader();
    mockedGetGrader.mockReturnValue(grader);
    runCases([makeCase(1)]);

    await processPendingEvaluationRuns();

    expect(createResult.mock.calls[0][0].data).toMatchObject({
      errorCode: 'case_observe_failed',
      errorMessage: 'score unreadable',
    });
    expect(grader.grade).not.toHaveBeenCalled();
  });

  it('does not observe a turn that failed', async () => {
    const observe = vi.fn();
    registerEvalCaseHooks('score-assistant', { observe });
    mockedRunAgent.mockResolvedValueOnce(drainOk({ errorCode: 'provider_error' }));
    mockedGetGrader.mockReturnValue(passingGrader());
    runCases([makeCase(1)]);

    await processPendingEvaluationRuns();

    expect(observe).not.toHaveBeenCalled();
    expect(createResult.mock.calls[0][0].data.errorCode).toBe('provider_error');
  });

  it('runs an agent with no hooks exactly as before', async () => {
    // Hooks for another agent: this one's run must not see them.
    registerEvalCaseHooks('other-agent', { setup: () => ({ contextType: 'x' }), observe: () => 1 });
    mockedRunAgent.mockResolvedValueOnce(drainOk());
    const grader = passingGrader();
    mockedGetGrader.mockReturnValue(grader);
    runCases([makeCase(1)]);

    await processPendingEvaluationRuns();

    expect(mockedRunAgent.mock.calls[0][0]).toEqual({
      agentSlug: 'score-assistant',
      userId: 'user-1',
      message: 'Question 1?',
      evaluationRunId: 'run-1',
    });
    const [input] = grader.grade.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).not.toHaveProperty('observed');
    // A case with no metadata adds nothing either.
    expect(input).not.toHaveProperty('caseMetadata');
  });
});
