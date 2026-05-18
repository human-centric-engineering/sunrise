/**
 * Tests for `lib/orchestration/engine/executors/supervisor.ts`.
 *
 * Coverage strategy: the executor's anti-optimism behaviour lives in pure
 * helpers (citation validator, truncation, JSON parser). Most assertions
 * target those directly. The executor end-to-end test wires `runLlmCall`
 * to a mock and verifies orchestration glue (run-time toggle, retry,
 * inconclusive verdict, failOnVerdict).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  runLlmCall: vi.fn(),
}));
vi.mock('@/lib/orchestration/evaluations/judge-model', () => ({
  JUDGE_MODEL: 'judge-model-id',
  JUDGE_PROVIDER: 'judge-provider',
  EVALUATION_DEFAULT_MODEL: 'default-model',
  EVALUATION_DEFAULT_PROVIDER: 'default-provider',
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { __test__, executeSupervisor } from '@/lib/orchestration/engine/executors/supervisor';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

const { sampleString, validateCitations, tryParse, buildProjection } = __test__;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: {},
    stepOutputs: {},
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
      withContext: vi.fn().mockReturnThis(),
    } as unknown as ExecutionContext['logger'],
    stepTelemetry: [],
    ...overrides,
  };
}

function step(config: Record<string, unknown>): WorkflowStep {
  return {
    id: 'supervisor_1',
    name: 'Neutral supervisor',
    type: 'supervisor',
    config,
    nextSteps: [],
  };
}

function validReport(): unknown {
  return {
    verdict: 'pass',
    score: 0.9,
    summary: 'The workflow met its objective.',
    strengths: [
      { claim: 'Apply step ran cleanly', evidenceStepId: 's1', evidenceQuote: 'applied 5 changes' },
    ],
    weaknesses: [
      {
        severity: 'low',
        claim: 'No regression test for new model added',
        evidenceStepId: 's2',
        evidenceQuote: 'created new model',
        recommendation: 'Add a regression test',
      },
    ],
    anomalies: [],
    unverifiedAreas: ['downstream consumer behaviour'],
    confidence: 'high',
  };
}

beforeEach(() => {
  vi.mocked(runLlmCall).mockReset();
});

// ─── Config validation ─────────────────────────────────────────────────────

describe('supervisorConfigSchema (via executor)', () => {
  it('rejects missing assessmentCriteria', async () => {
    await expect(executeSupervisor(step({}), makeCtx())).rejects.toThrow();
  });

  it("rejects failOnVerdict='fail' paired with errorStrategy='skip' (silent-swallow trap)", async () => {
    // Schema-level refinement: the engine's skip strategy would catch
    // the ExecutorError thrown by a fail verdict, hiding the signal.
    // Authoring this combination is a structural mistake — refuse it.
    await expect(
      executeSupervisor(
        step({
          assessmentCriteria: 'r',
          failOnVerdict: 'fail',
          errorStrategy: 'skip',
        }),
        makeCtx()
      )
    ).rejects.toThrow(/silently absorb|errorStrategy/i);
  });

  it("accepts failOnVerdict='fail' paired with errorStrategy='fail' (terminate)", async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify(validReport()),
      tokensUsed: 100,
      costUsd: 0.005,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' } });
    const result = await executeSupervisor(
      step({ assessmentCriteria: 'r', failOnVerdict: 'fail', errorStrategy: 'fail' }),
      ctx
    );
    expect((result.output as { verdict: string }).verdict).toBe('pass');
  });

  it('accepts the minimal valid config', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify(validReport()),
      tokensUsed: 100,
      costUsd: 0.001,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' } });
    const result = await executeSupervisor(
      step({ assessmentCriteria: 'Did the audit do its job?' }),
      ctx
    );
    expect(result.output).toMatchObject({ verdict: 'pass', triggeredBy: 'in_workflow' });
  });
});

// ─── Run-time toggle ────────────────────────────────────────────────────────

describe('run-time toggle (__runSupervisor)', () => {
  it('short-circuits with expectedSkip when __runSupervisor=false', async () => {
    const ctx = makeCtx({ inputData: { __runSupervisor: false } });
    const result = await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    expect(result.skipped).toBe(true);
    expect(result.expectedSkip).toBe(true);
    expect(result.tokensUsed).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(runLlmCall).not.toHaveBeenCalled();
    // skipError feeds the trace UI's "Reason" cell — without it the
    // viewer falls back to "no reason captured". Output.reason is the
    // programmatic mirror.
    expect(result.skipError).toBe('supervisor disabled at trigger time');
    expect(result.output).toMatchObject({
      skipped: true,
      reason: 'supervisor disabled at trigger time',
    });
  });

  it('runs when __runSupervisor is absent (key undefined)', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify(validReport()),
      tokensUsed: 10,
      costUsd: 0.001,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' } });
    await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    expect(runLlmCall).toHaveBeenCalledOnce();
  });

  it.each([
    ['string "false"', 'false'],
    ['string "true"', 'true'],
    ['number 0', 0],
    ['null', null],
    ['empty string', ''],
  ])(
    'does NOT skip when __runSupervisor is %s (only literal boolean false opts out)',
    async (_label, value) => {
      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: JSON.stringify(validReport()),
        tokensUsed: 10,
        costUsd: 0.001,
        model: 'judge-model-id',
      });
      const ctx = makeCtx({
        inputData: { __runSupervisor: value as never },
        stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' },
      });
      const result = await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
      expect(result.skipped).toBeUndefined();
      expect(runLlmCall).toHaveBeenCalledOnce();
    }
  );

  it('ignores __runSupervisor=false when respectRuntimeOptOut=false', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify(validReport()),
      tokensUsed: 10,
      costUsd: 0.001,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({
      inputData: { __runSupervisor: false },
      stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' },
    });
    await executeSupervisor(step({ assessmentCriteria: 'r', respectRuntimeOptOut: false }), ctx);
    expect(runLlmCall).toHaveBeenCalledOnce();
  });
});

// ─── Citation validator (pure helper) ──────────────────────────────────────

describe('validateCitations', () => {
  it('strips strengths citing unknown stepId', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'pass',
        score: 0.8,
        summary: 's',
        strengths: [
          { claim: 'good', evidenceStepId: 'ghost_step', evidenceQuote: 'whatever' },
          { claim: 'real', evidenceStepId: 'real_step', evidenceQuote: 'actually here' },
        ],
        weaknesses: [
          {
            severity: 'low',
            claim: 'minor nit',
            evidenceStepId: 'real_step',
            evidenceQuote: 'actually here',
            recommendation: 'fix',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'medium',
      })
    );
    expect(parsed).not.toBeNull();
    const { validatedReport } = validateCitations(
      parsed!,
      { real_step: 'this output contains actually here as substring' },
      1,
      true
    );
    expect(validatedReport.strengths).toHaveLength(1);
    expect(validatedReport.strengths[0].claim).toBe('real');
    expect(validatedReport.invalidCitations).toHaveLength(1);
    expect(validatedReport.invalidCitations![0].reason).toBe('unknown_step_id');
  });

  it('strips weaknesses where quote is not a substring of cited output', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'concerns',
        score: 0.5,
        summary: 's',
        strengths: [],
        weaknesses: [
          {
            severity: 'high',
            claim: 'made-up problem',
            evidenceStepId: 'real_step',
            evidenceQuote: 'this quote does not appear',
            recommendation: 'fix',
          },
          {
            severity: 'low',
            claim: 'real problem',
            evidenceStepId: 'real_step',
            evidenceQuote: 'an actual substring',
            recommendation: 'fix',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'medium',
      })
    );
    const { validatedReport } = validateCitations(
      parsed!,
      { real_step: 'output containing an actual substring inside it' },
      1,
      true
    );
    expect(validatedReport.weaknesses).toHaveLength(1);
    expect(validatedReport.weaknesses[0].claim).toBe('real problem');
    expect(validatedReport.invalidCitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'quote_not_found' })])
    );
  });

  it('downgrades verdict pass → concerns when minWeaknesses floor breaks', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'pass',
        score: 0.95,
        summary: 'all good',
        strengths: [],
        // All weaknesses cite unknown steps so they get stripped
        weaknesses: [
          {
            severity: 'low',
            claim: 'a',
            evidenceStepId: 'ghost',
            evidenceQuote: 'q',
            recommendation: 'r',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'high',
      })
    );
    const { validatedReport, downgraded } = validateCitations(parsed!, {}, 1, true);
    expect(downgraded).toBe(true);
    expect(validatedReport.verdict).toBe('concerns');
  });

  it('downgrades verdict concerns → fail when floor breaks', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'concerns',
        score: 0.5,
        summary: 's',
        strengths: [],
        weaknesses: [
          {
            severity: 'low',
            claim: 'a',
            evidenceStepId: 'ghost',
            evidenceQuote: 'q',
            recommendation: 'r',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'medium',
      })
    );
    const { validatedReport } = validateCitations(parsed!, {}, 1, true);
    expect(validatedReport.verdict).toBe('fail');
  });

  it('keeps a weakness with null evidence (the no-defects escape hatch)', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'pass',
        score: 0.95,
        summary: 's',
        strengths: [],
        weaknesses: [
          {
            severity: 'low',
            claim: 'no defects found and the following steps were verified: s1',
            evidenceStepId: null,
            evidenceQuote: null,
            recommendation: 'continue monitoring',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'high',
      })
    );
    const { validatedReport, downgraded } = validateCitations(parsed!, { s1: 'output' }, 1, true);
    expect(downgraded).toBe(false);
    expect(validatedReport.weaknesses).toHaveLength(1);
    expect(validatedReport.verdict).toBe('pass');
  });

  it('skips validation when requireEvidenceCitations=false', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'pass',
        score: 0.9,
        summary: 's',
        strengths: [{ claim: 'x', evidenceStepId: 'ghost', evidenceQuote: 'whatever' }],
        weaknesses: [
          {
            severity: 'low',
            claim: 'y',
            evidenceStepId: 'ghost',
            evidenceQuote: 'whatever',
            recommendation: 'r',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'medium',
      })
    );
    const { validatedReport } = validateCitations(parsed!, {}, 1, false);
    expect(validatedReport.invalidCitations).toBeUndefined();
    expect(validatedReport.strengths).toHaveLength(1);
    expect(validatedReport.weaknesses).toHaveLength(1);
  });
});

// ─── Truncation helper ─────────────────────────────────────────────────────

describe('sampleString', () => {
  it('returns the original string when under the cap', () => {
    expect(sampleString('hello', 100)).toBe('hello');
  });

  it('samples head + middle + tail when over the cap with elision markers', () => {
    const long = 'A'.repeat(100) + 'M'.repeat(100) + 'Z'.repeat(100);
    const out = sampleString(long, 60);
    // Head has A's, middle has M's, tail has Z's, and elision markers between.
    expect(out).toContain('A');
    expect(out).toContain('M');
    expect(out).toContain('Z');
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(long.length);
  });
});

// ─── Trace projection ──────────────────────────────────────────────────────

describe('buildProjection', () => {
  it('handles empty stepOutputs', () => {
    const ctx = makeCtx();
    const { projection, mostRecentStepId } = buildProjection(ctx, 'auto');
    expect(projection).toEqual([]);
    expect(mostRecentStepId).toBeNull();
  });

  it('returns one ProjectedStep per stepOutput key with byte counts', () => {
    const ctx = makeCtx({ stepOutputs: { a: { x: 1 }, b: 'short' } });
    const { projection } = buildProjection(ctx, 'auto');
    expect(projection).toHaveLength(2);
    expect(projection[0].stepId).toBe('a');
    expect(projection[0].outputBytes).toBeGreaterThan(0);
    expect(projection[1].output).toBe('short');
  });

  it('terminal-only mode truncates earlier steps but keeps the last in full', () => {
    const longOutput = 'X'.repeat(10_000);
    const ctx = makeCtx({ stepOutputs: { early: longOutput, late: 'final' } });
    const { projection } = buildProjection(ctx, 'terminal-only');
    // 'early' was truncated, 'late' is preserved verbatim
    expect(projection[0].output.length).toBeLessThan(longOutput.length);
    expect(projection[1].output).toBe('final');
  });
});

// ─── End-to-end executor behaviour ─────────────────────────────────────────

describe('executeSupervisor (end-to-end)', () => {
  it('happy path: parses JSON, returns SupervisorReport with triggeredBy=in_workflow', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify(validReport()),
      tokensUsed: 200,
      costUsd: 0.01,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({
      stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' },
    });
    const result = await executeSupervisor(step({ assessmentCriteria: 'audit rubric' }), ctx);
    const out = result.output as { verdict: string; triggeredBy: string };
    expect(out.verdict).toBe('pass');
    expect(out.triggeredBy).toBe('in_workflow');
    expect(result.tokensUsed).toBe(200);
    expect(result.costUsd).toBeCloseTo(0.01);
  });

  it('retries at temperature=0 on first malformed response', async () => {
    vi.mocked(runLlmCall)
      .mockResolvedValueOnce({
        content: 'not JSON at all',
        tokensUsed: 50,
        costUsd: 0.001,
        model: 'judge-model-id',
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(validReport()),
        tokensUsed: 200,
        costUsd: 0.01,
        model: 'judge-model-id',
      });
    const ctx = makeCtx({ stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' } });
    const result = await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    expect(runLlmCall).toHaveBeenCalledTimes(2);
    // Retry call uses temperature 0
    expect(vi.mocked(runLlmCall).mock.calls[1][1]).toMatchObject({ temperature: 0 });
    expect((result.output as { verdict: string }).verdict).toBe('pass');
    // Tokens / cost accumulate across attempts
    expect(result.tokensUsed).toBe(250);
  });

  it('returns inconclusive verdict when both attempts produce malformed JSON', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'still not JSON',
      tokensUsed: 50,
      costUsd: 0.001,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'output' } });
    const result = await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    const out = result.output as { verdict: string; parseFailure: { rawResponse: string } };
    expect(out.verdict).toBe('inconclusive');
    expect(out.parseFailure.rawResponse).toContain('still not JSON');
    // Did NOT throw — the operator still gets a signal.
  });

  it('throws ExecutorError when failOnVerdict=fail and verdict is fail', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify({
        ...(validReport() as object),
        verdict: 'fail',
        weaknesses: [
          {
            severity: 'high',
            claim: 'critical problem',
            evidenceStepId: 's1',
            evidenceQuote: 'applied 5 changes',
            recommendation: 'roll back',
          },
        ],
      }),
      tokensUsed: 100,
      costUsd: 0.005,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' } });
    await expect(
      executeSupervisor(step({ assessmentCriteria: 'r', failOnVerdict: 'fail' }), ctx)
    ).rejects.toBeInstanceOf(ExecutorError);
  });

  it('does NOT throw when verdict is fail but failOnVerdict=never (default)', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify({
        ...(validReport() as object),
        verdict: 'fail',
        weaknesses: [
          {
            severity: 'high',
            claim: 'critical problem',
            evidenceStepId: 's1',
            evidenceQuote: 'applied 5 changes',
            recommendation: 'roll back',
          },
        ],
      }),
      tokensUsed: 100,
      costUsd: 0.005,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' } });
    const result = await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    expect((result.output as { verdict: string }).verdict).toBe('fail');
  });

  it('uses JUDGE_MODEL as modelOverride when useJudgeModel=true (default) and no override set', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify(validReport()),
      tokensUsed: 100,
      costUsd: 0.005,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' } });
    await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    expect(vi.mocked(runLlmCall).mock.calls[0][1]).toMatchObject({
      modelOverride: 'judge-model-id',
    });
  });

  it('emits contextPatch with all four supervisor columns on the happy path', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify(validReport()),
      tokensUsed: 100,
      costUsd: 0.005,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' } });
    const result = await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    expect(result.contextPatch).toBeDefined();
    expect(result.contextPatch).toMatchObject({
      supervisorVerdict: 'pass',
      supervisorScore: expect.any(Number),
      supervisorReport: expect.any(Object),
      supervisorReviewedAt: expect.any(Date),
    });
  });

  it('emits contextPatch even when the verdict is inconclusive (parse failure)', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'still not JSON',
      tokensUsed: 50,
      costUsd: 0.001,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'output' } });
    const result = await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    expect(result.contextPatch).toMatchObject({
      supervisorVerdict: 'inconclusive',
      supervisorScore: 0,
    });
  });

  it('does NOT emit contextPatch when the step is run-time-skipped', async () => {
    const ctx = makeCtx({ inputData: { __runSupervisor: false } });
    const result = await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    expect(result.contextPatch).toBeUndefined();
  });

  it('runs cleanly when stepOutputs is empty (supervisor placed first — unusual but supported)', async () => {
    // If a workflow places the supervisor as its first step, ctx.stepOutputs
    // is empty. buildProjection returns no entries; the prompt asks the
    // judge to audit "(no steps in trace yet)". The LLM might reasonably
    // return inconclusive — but the executor must not throw.
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify({
        ...(validReport() as object),
        verdict: 'concerns',
        weaknesses: [
          {
            severity: 'low',
            claim: 'no defects found and the following steps were verified: (none)',
            evidenceStepId: null,
            evidenceQuote: null,
            recommendation: 'Place supervisor at the end of the workflow, not the start.',
          },
        ],
        unverifiedAreas: ['entire workflow — supervisor invoked before any steps completed'],
      }),
      tokensUsed: 50,
      costUsd: 0.002,
      model: 'judge-model-id',
    });
    const ctx = makeCtx({ stepOutputs: {} }); // explicitly empty
    const result = await executeSupervisor(step({ assessmentCriteria: 'r' }), ctx);
    expect((result.output as { verdict: string }).verdict).toBe('concerns');
    expect(runLlmCall).toHaveBeenCalledOnce();
  });

  it('explicit modelOverride beats JUDGE_MODEL', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify(validReport()),
      tokensUsed: 100,
      costUsd: 0.005,
      model: 'custom-model',
    });
    const ctx = makeCtx({ stepOutputs: { s1: 'applied 5 changes', s2: 'created new model' } });
    await executeSupervisor(step({ assessmentCriteria: 'r', modelOverride: 'custom-model' }), ctx);
    expect(vi.mocked(runLlmCall).mock.calls[0][1]).toMatchObject({ modelOverride: 'custom-model' });
  });
});
