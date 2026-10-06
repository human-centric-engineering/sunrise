/**
 * Tests for `lib/orchestration/engine/executors/judge-call.ts`.
 *
 * Mocks `driveJudgeAgent` at the module boundary. Covers:
 *   - Happy path: score + reasoning + passed=true.
 *   - Threshold: passed=false when score < threshold.
 *   - No threshold: passed always true.
 *   - Null score with a threshold: the step fails with the judge's errorCode,
 *     or judge_not_applicable when the judge chose not to score, retriable
 *     unless a retry cannot change it (t-747).
 *   - Null score without a threshold: passed=true, errorCode on the output.
 *   - evaluationSteps propagated when present.
 *   - Template interpolation of question / answer fields.
 *   - Missing judgeAgentSlug → ExecutorError('missing_judge_agent_slug').
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/judge-driver', () => ({
  driveJudgeAgent: vi.fn(),
}));

import {
  executeJudgeCall,
  JUDGE_NOT_APPLICABLE,
} from '@/lib/orchestration/engine/executors/judge-call';
import { driveJudgeAgent } from '@/lib/orchestration/evaluations/judge-driver';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

const mockedDrive = driveJudgeAgent as unknown as ReturnType<typeof vi.fn>;

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { question: 'what is 2+2?' },
    stepOutputs: { prior: '4' },
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),

      withContext: vi.fn().mockReturnThis(),
    } as any,
    ...overrides,
  };
}

function makeStep(overrides?: Partial<WorkflowStep['config']>): WorkflowStep {
  return {
    id: 'jc1',
    name: 'Judge Call',
    type: 'judge_call',
    config: {
      judgeAgentSlug: 'eval-judge-correctness',
      question: '{{input.question}}',
      answer: '{{prior.output}}',
      threshold: 0.7,
      ...overrides,
    },
    nextSteps: [],
  };
}

function driveResult(overrides: Record<string, unknown> = {}) {
  return {
    score: 0.85,
    reasoning: 'Correct and concise.',
    costUsd: 0.012,
    tokenUsage: { input: 60, output: 18 },
    ...overrides,
  };
}

describe('executeJudgeCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the run's cost tags to the judge, which does NOT log through an executor", async () => {
    // A comment here used to assert the opposite — that
    // `ExecuteOptions.costLogMetadata` "already tags every cost row via the
    // executors' merged metadata". It does not: `driveJudgeAgent` goes to
    // `drainStreamChat` → the streaming chat handler, whose `logCost` calls
    // tag from `request.costLogMetadata` only. Evaluating a workflow with a
    // `judge_call` step therefore tagged every other step and left the
    // judge's spend untagged (#600).
    mockedDrive.mockResolvedValueOnce(driveResult());

    await executeJudgeCall(
      makeStep(),
      makeCtx({ costLogMetadata: { evaluationRunId: 'run_7', role: 'subject' } })
    );

    // `evaluationRunId` survives — that is the tag this test is about. `role`
    // is deliberately overridden to `'judge'`; the test below covers why.
    expect(mockedDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        costLogMetadata: expect.objectContaining({ evaluationRunId: 'run_7' }),
      })
    );
  });

  it("tags the judge as 'judge' even inside a run stamped 'subject'", async () => {
    // A subject workflow's execution carries `role: 'subject'`
    // (`run-cases/workflow-case.ts`). Forwarding that wholesale would tag the
    // JUDGE agent's chat rows as subject spend, so the first role-based split
    // of evaluation cost would bill the judge to the thing it judged. Every
    // other judge path sets `role: 'judge'` explicitly (#600).
    mockedDrive.mockResolvedValueOnce(driveResult());

    await executeJudgeCall(
      makeStep(),
      makeCtx({ costLogMetadata: { evaluationRunId: 'run_7', role: 'subject' } })
    );

    expect(mockedDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        costLogMetadata: { evaluationRunId: 'run_7', role: 'judge' },
      })
    );
  });

  it('omits the tags entirely when the run carries none', async () => {
    mockedDrive.mockResolvedValueOnce(driveResult());

    await executeJudgeCall(makeStep(), makeCtx());

    const [input] = mockedDrive.mock.calls[0] as [Record<string, unknown>];
    expect(input).not.toHaveProperty('costLogMetadata');
  });

  it('drives the judge with interpolated question + answer, returns score + passed=true when score >= threshold', async () => {
    mockedDrive.mockResolvedValueOnce(driveResult());

    const result = await executeJudgeCall(makeStep(), makeCtx());

    expect(mockedDrive).toHaveBeenCalledTimes(1);
    const args = mockedDrive.mock.calls[0][0] as Record<string, unknown>;
    expect(args.agentSlug).toBe('eval-judge-correctness');
    expect(args.userId).toBe('user_1');
    expect(args.question).toBe('what is 2+2?');
    // `stepOutputs.prior` resolves via `{{prior.output}}` — engine
    // interpolation pulls stepOutputs[stepId].
    expect(args.answer).toBe('4');

    expect(result.output).toMatchObject({
      score: 0.85,
      reasoning: 'Correct and concise.',
      passed: true,
      threshold: 0.7,
      judgeAgentSlug: 'eval-judge-correctness',
    });
    expect(result.costUsd).toBe(0.012);
    expect(result.tokensUsed).toBe(78);
  });

  it('passed=false when score < threshold', async () => {
    mockedDrive.mockResolvedValueOnce(driveResult({ score: 0.4 }));

    const result = await executeJudgeCall(makeStep(), makeCtx());

    expect((result.output as { passed: boolean }).passed).toBe(false);
  });

  it('passed=true (and threshold=null) when no threshold is configured', async () => {
    mockedDrive.mockResolvedValueOnce(driveResult({ score: 0.1 }));

    const result = await executeJudgeCall(makeStep({ threshold: undefined }), makeCtx());

    expect((result.output as { passed: boolean; threshold: number | null }).passed).toBe(true);
    expect((result.output as { threshold: number | null }).threshold).toBeNull();
  });

  it('propagates evaluationSteps onto the step output when the judge returned them', async () => {
    mockedDrive.mockResolvedValueOnce(
      driveResult({ evaluationSteps: ['Step 1', 'Step 2', 'Step 3'] })
    );

    const result = await executeJudgeCall(makeStep(), makeCtx());

    expect((result.output as { evaluationSteps: string[] }).evaluationSteps).toEqual([
      'Step 1',
      'Step 2',
      'Step 3',
    ]);
  });

  describe('a judge that returns no score (§77 t-747)', () => {
    // `driveJudgeAgent` folds a failure into `score: null` plus an
    // `errorCode`, and a judge whose criterion does not apply returns
    // `score: null` with none. With a threshold, the step used to report
    // passed=true for both, so a quality gate opened for anything unjudged.
    it.each([
      // Transient, or worth another attempt.
      ['provider_error', true],
      ['malformed_judge_response', true],
      // The provider's request faults (`isRequestFaultCode`).
      ['provider_not_permitted', false],
      ['truncated_no_output', false],
      // Configuration, budget, and the chat handler's guards and loop cap.
      ['no_provider_configured', false],
      ['no_eligible_provider', false],
      ['agent_not_found', false],
      ['budget_exceeded', false],
      ['output_blocked', false],
      ['tool_loop_cap', false],
    ])(
      'with a threshold, fails the step with the judge’s %s (retriable: %s)',
      async (errorCode, retriable) => {
        mockedDrive.mockResolvedValueOnce(
          driveResult({ score: null, reasoning: `judge call error: ${errorCode}`, errorCode })
        );

        const failure = executeJudgeCall(makeStep(), makeCtx());

        await expect(failure).rejects.toBeInstanceOf(ExecutorError);
        await expect(failure).rejects.toMatchObject({ stepId: 'jc1', code: errorCode, retriable });
      }
    );

    it('carries the judge call’s spend when the reply was paid for but unparseable', async () => {
      // A malformed reply follows a completed call, so its usage is real; it
      // rides on the error so skip, fallback and retry account for it.
      mockedDrive.mockResolvedValueOnce(
        driveResult({ score: null, errorCode: 'malformed_judge_response' })
      );

      await expect(executeJudgeCall(makeStep(), makeCtx())).rejects.toMatchObject({
        tokensUsed: 78,
        costUsd: 0.012,
      });
    });

    it('fails the step when the judge finds its criterion not applicable, and says why', async () => {
      // A faithfulness judge on an answer with no citations: a deliberate
      // null with no errorCode. Owner ruling: a gate passes only on a score.
      mockedDrive.mockResolvedValueOnce(
        driveResult({ score: null, reasoning: 'no citations\non the response' })
      );

      const failure = executeJudgeCall(makeStep(), makeCtx());

      await expect(failure).rejects.toMatchObject({
        code: JUDGE_NOT_APPLICABLE,
        retriable: false,
        message: expect.stringContaining('not applicable: no citations on the response'),
      });
    });

    it('bounds the judge’s reasoning in the message to one short line', async () => {
      mockedDrive.mockResolvedValueOnce(driveResult({ score: null, reasoning: 'x'.repeat(5000) }));

      const err: unknown = await executeJudgeCall(makeStep(), makeCtx()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ExecutorError);
      expect((err as ExecutorError).message.length).toBeLessThan(400);
    });

    it('without a threshold, still reports passed=true and carries the errorCode', async () => {
      // A judge with no threshold scores rather than gates: unchanged.
      mockedDrive.mockResolvedValueOnce(
        driveResult({
          score: null,
          reasoning: 'malformed JSON',
          errorCode: 'malformed_judge_response',
        })
      );

      const result = await executeJudgeCall(makeStep({ threshold: undefined }), makeCtx());

      expect(result.output).toMatchObject({
        score: null,
        passed: true,
        threshold: null,
        errorCode: 'malformed_judge_response',
      });
    });
  });

  it('throws ExecutorError when judgeAgentSlug is empty', async () => {
    await expect(
      executeJudgeCall(makeStep({ judgeAgentSlug: '   ' }), makeCtx())
    ).rejects.toMatchObject({ code: 'missing_judge_agent_slug' });
    expect(mockedDrive).not.toHaveBeenCalled();
  });

  it('throws judge_call_requires_user_context when ctx.userId is null', async () => {
    await expect(executeJudgeCall(makeStep(), makeCtx({ userId: null }))).rejects.toMatchObject({
      code: 'judge_call_requires_user_context',
    });
    expect(mockedDrive).not.toHaveBeenCalled();
  });

  it('propagates the interpolated subjectBrandVoice when set in config', async () => {
    mockedDrive.mockResolvedValueOnce(driveResult());

    await executeJudgeCall(
      makeStep({ subjectBrandVoice: 'warm and informal' }),
      makeCtx({ inputData: { question: 'x' }, stepOutputs: { prior: 'y' } })
    );

    const args = mockedDrive.mock.calls[0][0] as Record<string, unknown>;
    expect(args.subjectBrandVoice).toBe('warm and informal');
  });

  it('omits expectedOutput from the driver call when the template resolves to empty', async () => {
    mockedDrive.mockResolvedValueOnce(driveResult());

    await executeJudgeCall(
      makeStep({ expectedOutput: '{{missing.output}}' }),
      makeCtx({ inputData: {}, stepOutputs: {} })
    );

    const args = mockedDrive.mock.calls[0][0] as Record<string, unknown>;
    // `{{missing.output}}` interpolates to '' — the executor drops the
    // field rather than passing '' through (the driver treats empty
    // strings as "no expected output").
    expect(args).not.toHaveProperty('expectedOutput');
  });
});
