/**
 * Tests for `lib/orchestration/engine/executors/reflect.ts`.
 *
 * Covers:
 *   - Converges when LLM includes a "no further changes" marker.
 *   - Missing critiquePrompt → ExecutorError('missing_critique_prompt').
 *   - Max iterations reached when every call produces new content.
 *   - Converges on the first iteration.
 *   - Tokens and cost accumulated correctly across iterations.
 *
 * Implementation note on finalDraft:
 *   The loop updates `draft = result.content` only when the LLM does NOT
 *   respond with a convergence marker. On convergence the draft retains
 *   the content from the last non-converging call (or the seed if the
 *   first call converges). This is the value stored in `output.finalDraft`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  runLlmCall: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeReflect } from '@/lib/orchestration/engine/executors/reflect';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: {},
    stepOutputs: { prev: 'initial draft' },
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

function makeStep(configOverrides?: Record<string, unknown>): WorkflowStep {
  return {
    id: 'reflect1',
    name: 'Test Reflect',
    type: 'reflect',
    config: {
      critiquePrompt: 'Improve this draft',
      maxIterations: 3,
      ...configOverrides,
    },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeReflect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converges on iteration 2: finalDraft is last meaningful content before convergence', async () => {
    vi.mocked(runLlmCall)
      .mockResolvedValueOnce({
        content: 'revised draft',
        tokensUsed: 10,
        costUsd: 0.01,
        model: 'm',
      })
      .mockResolvedValueOnce({
        content: 'No further changes needed',
        tokensUsed: 8,
        costUsd: 0.008,
        model: 'm',
      });

    const result = await executeReflect(makeStep(), makeCtx());

    expect(result.output).toMatchObject({
      stopReason: 'converged',
      iterations: 2,
      finalDraft: 'revised draft',
    });
  });

  it('throws ExecutorError with code "missing_critique_prompt" when critiquePrompt is absent', async () => {
    const step = makeStep({ critiquePrompt: undefined });

    await expect(executeReflect(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_critique_prompt',
    });
  });

  it('throws ExecutorError with code "missing_critique_prompt" when critiquePrompt is empty', async () => {
    const step = makeStep({ critiquePrompt: '   ' });

    await expect(executeReflect(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_critique_prompt',
    });
  });

  it('reaches max iterations when every call produces new content', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'new content each time',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const step = makeStep({ maxIterations: 2 });
    const result = await executeReflect(step, makeCtx());

    expect(result.output).toMatchObject({
      stopReason: 'max_iterations',
      iterations: 2,
    });
    expect(runLlmCall).toHaveBeenCalledTimes(2);
  });

  it('converges on the first iteration when the initial draft already meets criteria', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'looks good as is',
      tokensUsed: 4,
      costUsd: 0.004,
      model: 'm',
    });

    const result = await executeReflect(makeStep(), makeCtx());

    expect(result.output).toMatchObject({
      stopReason: 'converged',
      iterations: 1,
      // Converged immediately: draft was never updated, so finalDraft is the seed
      finalDraft: 'initial draft',
    });
    expect(runLlmCall).toHaveBeenCalledTimes(1);
  });

  it('accumulates tokens and cost across iterations', async () => {
    vi.mocked(runLlmCall)
      .mockResolvedValueOnce({
        content: 'iteration 1 content',
        tokensUsed: 10,
        costUsd: 0.01,
        model: 'm',
      })
      .mockResolvedValueOnce({
        content: 'No further changes',
        tokensUsed: 10,
        costUsd: 0.01,
        model: 'm',
      });

    const result = await executeReflect(makeStep(), makeCtx());

    expect(result.tokensUsed).toBe(20);
    expect(result.costUsd).toBeCloseTo(0.02);
  });

  it('uses last step output from stepOutputs as the initial draft seed', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'No further changes needed',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    // The seed is ctx.stepOutputs[lastKey]
    const ctx = makeCtx({ stepOutputs: { step_a: 'my seed draft' } });
    const result = await executeReflect(makeStep(), ctx);

    expect(result.output).toMatchObject({
      finalDraft: 'my seed draft',
      stopReason: 'converged',
    });
    // Verify the prompt passed to runLlmCall contains the seed draft
    expect(vi.mocked(runLlmCall).mock.calls[0][1].prompt).toContain('my seed draft');
  });

  it('defaults to maxIterations=3 when not specified', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'always new content',
      tokensUsed: 2,
      costUsd: 0.002,
      model: 'm',
    });

    const step = makeStep({ maxIterations: undefined });
    await executeReflect(step, makeCtx());

    expect(runLlmCall).toHaveBeenCalledTimes(3);
  });

  // ─── stringifyValue() branch coverage ────────────────────────────────

  it('uses empty string as initial draft when stepOutputs is empty', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'No further changes',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    const ctx = makeCtx({ stepOutputs: {} });
    const result = await executeReflect(makeStep(), ctx);

    expect(result.output).toMatchObject({ finalDraft: '', stopReason: 'converged' });
    expect(vi.mocked(runLlmCall).mock.calls[0][1].prompt).toContain('Current draft:\n\n');
  });

  it('stringifies a numeric step output into the draft prompt', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'No further changes needed',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    const ctx = makeCtx({ stepOutputs: { prev: 42 } });
    const result = await executeReflect(makeStep(), ctx);

    expect(result.output).toMatchObject({ finalDraft: '42', stopReason: 'converged' });
    expect(vi.mocked(runLlmCall).mock.calls[0][1].prompt).toContain('42');
  });

  it('stringifies a boolean step output into the draft prompt', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'No further changes',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    const ctx = makeCtx({ stepOutputs: { prev: true } });
    const result = await executeReflect(makeStep(), ctx);

    expect(result.output).toMatchObject({ finalDraft: 'true', stopReason: 'converged' });
    expect(vi.mocked(runLlmCall).mock.calls[0][1].prompt).toContain('true');
  });

  it('JSON-stringifies an object step output into the draft prompt', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'No further changes',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    const ctx = makeCtx({ stepOutputs: { prev: { key: 'value', n: 1 } } });
    const result = await executeReflect(makeStep(), ctx);

    const expectedJson = JSON.stringify({ key: 'value', n: 1 });
    expect(result.output).toMatchObject({ finalDraft: expectedJson, stopReason: 'converged' });
    expect(vi.mocked(runLlmCall).mock.calls[0][1].prompt).toContain(expectedJson);
  });

  it('returns "[unserializable]" for a circular object step output', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'No further changes',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const ctx = makeCtx({ stepOutputs: { prev: circular } });
    const result = await executeReflect(makeStep(), ctx);

    expect(result.output).toMatchObject({
      finalDraft: '[unserializable]',
      stopReason: 'converged',
    });
  });

  it('returns empty string for null step output', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'No further changes',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    const ctx = makeCtx({ stepOutputs: { prev: null } });
    const result = await executeReflect(makeStep(), ctx);

    expect(result.output).toMatchObject({ finalDraft: '', stopReason: 'converged' });
  });

  it('defaults to maxIterations=3 when maxIterations is negative', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'always new',
      tokensUsed: 2,
      costUsd: 0.002,
      model: 'm',
    });

    const step = makeStep({ maxIterations: -1 });
    await executeReflect(step, makeCtx());

    expect(runLlmCall).toHaveBeenCalledTimes(3);
  });

  it('passes modelOverride and temperature to runLlmCall', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'No further changes',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'custom-model',
    });

    const step = makeStep({ modelOverride: 'custom-model', temperature: 0.7 });
    await executeReflect(step, makeCtx());

    expect(vi.mocked(runLlmCall).mock.calls[0][1]).toMatchObject({
      modelOverride: 'custom-model',
      temperature: 0.7,
    });
  });

  // ─── Multi-turn checkpoint resume ───────────────────────────────────────────

  describe('multi-turn checkpoint resume', () => {
    // Nested beforeEach: reset runLlmCall to a clean slate before each resume
    // test to prevent mock-default leak from the 16 sibling tests above
    // (gotcha #22 — module-mock defaults survive vi.clearAllMocks()).
    beforeEach(() => {
      vi.mocked(runLlmCall).mockReset();
    });

    it('fresh start (no resumeTurns): startIteration=0, recordTurn fires with 0-based iteration index', async () => {
      // Arrange: 2-iteration scenario — first produces revised content,
      // second responds with a convergence marker.
      vi.mocked(runLlmCall)
        .mockResolvedValueOnce({
          content: 'revised content',
          tokensUsed: 10,
          costUsd: 0.01,
          model: 'm',
        })
        .mockResolvedValueOnce({
          content: 'No further changes needed',
          tokensUsed: 8,
          costUsd: 0.008,
          model: 'm',
        });

      const recordTurn = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({ recordTurn });

      // Act
      const result = await executeReflect(makeStep(), ctx);

      // Assert: observable outcome — 2 iterations, converged
      expect(result.output).toMatchObject({ stopReason: 'converged', iterations: 2 });

      // Assert: internal effect — recordTurn called twice with correct 0-based indices
      expect(recordTurn).toHaveBeenCalledTimes(2);
      expect(recordTurn).toHaveBeenNthCalledWith(1, {
        kind: 'reflect',
        iteration: 0,
        draft: 'revised content',
        converged: false,
        tokensUsed: 10,
        costUsd: 0.01,
      });
      expect(recordTurn).toHaveBeenNthCalledWith(2, {
        kind: 'reflect',
        iteration: 1,
        draft: 'revised content', // draft not updated on convergence
        converged: true,
        tokensUsed: 8,
        costUsd: 0.008,
      });
    });

    it('fresh start with empty resumeTurns array: behaves identically to undefined, no short-circuit', async () => {
      // Arrange: explicit empty array — must not trigger the priorTurns path.
      // Use maxIterations=1 so only one LLM call is needed; we're testing that
      // the run proceeds (no short-circuit), not that it runs N times.
      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'new draft',
        tokensUsed: 5,
        costUsd: 0.005,
        model: 'm',
      });

      const ctx = makeCtx({ resumeTurns: [] });

      // Act
      await executeReflect(makeStep({ maxIterations: 1 }), ctx);

      // Assert: LLM WAS called (no erroneous short-circuit on empty array)
      expect(runLlmCall).toHaveBeenCalledTimes(1);
    });

    it('resume with prior non-converged turns: picks up from last draft at startIteration=lastIndex+1', async () => {
      // Arrange: 3 prior non-converged turns
      const priorTurns = [
        {
          kind: 'reflect' as const,
          iteration: 0,
          draft: 'd0',
          converged: false,
          tokensUsed: 10,
          costUsd: 0.01,
        },
        {
          kind: 'reflect' as const,
          iteration: 1,
          draft: 'd1',
          converged: false,
          tokensUsed: 12,
          costUsd: 0.012,
        },
        {
          kind: 'reflect' as const,
          iteration: 2,
          draft: 'd2',
          converged: false,
          tokensUsed: 8,
          costUsd: 0.008,
        },
      ];
      // Resume fires one more iteration starting at i=3 with draft='d2'
      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'No further changes',
        tokensUsed: 6,
        costUsd: 0.006,
        model: 'm',
      });

      const ctx = makeCtx({ resumeTurns: priorTurns });

      // Act
      const result = await executeReflect(makeStep({ maxIterations: 4 }), ctx);

      // Assert: observable outcome — started at iteration 3, ran once, total 4 iterations
      expect(result.output).toMatchObject({ stopReason: 'converged', iterations: 4 });

      // Assert: LLM called exactly once (continued from where we left off)
      expect(runLlmCall).toHaveBeenCalledTimes(1);

      // Assert: prompt included the last prior draft ('d2'), not the step seed
      const promptPassed = vi.mocked(runLlmCall).mock.calls[0][1].prompt;
      expect(promptPassed).toContain('d2');
    });

    it('resume with prior turns: tokens/cost accumulate across resume boundary (whole history)', async () => {
      // Arrange: 3 prior turns with known totals, plus one new LLM call
      const priorTurns = [
        {
          kind: 'reflect' as const,
          iteration: 0,
          draft: 'd0',
          converged: false,
          tokensUsed: 10,
          costUsd: 0.01,
        },
        {
          kind: 'reflect' as const,
          iteration: 1,
          draft: 'd1',
          converged: false,
          tokensUsed: 12,
          costUsd: 0.012,
        },
        {
          kind: 'reflect' as const,
          iteration: 2,
          draft: 'd2',
          converged: false,
          tokensUsed: 8,
          costUsd: 0.008,
        },
      ];
      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'No further changes',
        tokensUsed: 5,
        costUsd: 0.005,
        model: 'm',
      });

      const ctx = makeCtx({ resumeTurns: priorTurns });

      // Act
      const result = await executeReflect(makeStep({ maxIterations: 4 }), ctx);

      // Assert: StepResult totals = sum of all priors (10+12+8=30) PLUS new call (5)
      expect(result.tokensUsed).toBe(35);
      expect(result.costUsd).toBeCloseTo(0.035);
    });

    it('resume short-circuit: converged last prior turn returns immediately without calling LLM', async () => {
      // Arrange: prior turns where last entry has converged=true
      const priorTurns = [
        {
          kind: 'reflect' as const,
          iteration: 0,
          draft: 'draft0',
          converged: false,
          tokensUsed: 10,
          costUsd: 0.01,
        },
        {
          kind: 'reflect' as const,
          iteration: 1,
          draft: 'draft1',
          converged: false,
          tokensUsed: 12,
          costUsd: 0.012,
        },
        {
          kind: 'reflect' as const,
          iteration: 2,
          draft: 'final',
          converged: true,
          tokensUsed: 5,
          costUsd: 0.005,
        },
      ];

      const ctx = makeCtx({ resumeTurns: priorTurns });

      // Act
      const result = await executeReflect(makeStep(), ctx);

      // Assert: observable outcome — short-circuit returns cached final draft
      expect(result.output).toMatchObject({
        finalDraft: 'final',
        iterations: 3, // lastPrior.iteration + 1 = 2 + 1
        stopReason: 'converged',
      });

      // Assert: no LLM call fired (not.toHaveBeenCalled per gotcha #23 — no mockImplementation leak)
      expect(runLlmCall).not.toHaveBeenCalled();

      // Assert: accumulated cost/tokens include ALL prior turns (not zero — accumulation matters)
      expect(result.tokensUsed).toBe(27); // 10+12+5
      expect(result.costUsd).toBeCloseTo(0.027); // 0.01+0.012+0.005
    });

    it('recordTurn called with per-iteration cost (not running cumulative)', async () => {
      // Arrange: one non-converging iteration
      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'rev1',
        tokensUsed: 100,
        costUsd: 0.01,
        model: 'm',
      });
      // Second call converges so we stop
      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'No further changes',
        tokensUsed: 20,
        costUsd: 0.002,
        model: 'm',
      });

      const recordTurn = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({ recordTurn });

      // Act
      await executeReflect(makeStep(), ctx);

      // Assert: first recordTurn call uses per-call values (100 / 0.01), NOT cumulative
      expect(recordTurn).toHaveBeenNthCalledWith(1, {
        kind: 'reflect',
        iteration: 0,
        draft: 'rev1',
        converged: false,
        tokensUsed: 100,
        costUsd: 0.01,
      });
    });

    it('recordTurn called BEFORE convergence break (converged turn persists in cache)', async () => {
      // Arrange: single iteration that converges immediately
      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'looks good as is',
        tokensUsed: 4,
        costUsd: 0.004,
        model: 'm',
      });

      const recordTurn = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({ recordTurn });

      // Act
      await executeReflect(makeStep(), ctx);

      // Assert: recordTurn was called (not skipped) even though the run converged
      expect(recordTurn).toHaveBeenCalledTimes(1);
      expect(recordTurn).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'reflect', converged: true })
      );

      // Assert: loop did not re-fire after the convergence break
      expect(runLlmCall).toHaveBeenCalledTimes(1);
    });

    it('recordTurn is optional: ctx without recordTurn runs without error', async () => {
      // Arrange: ctx with no recordTurn property — must not crash on
      // ctx.recordTurn?.() optional chaining. Use maxIterations=1 so we
      // only need one LLM call mock, while still verifying the executor
      // completes normally with a non-converging response.
      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'reasonable draft',
        tokensUsed: 5,
        costUsd: 0.005,
        model: 'm',
      });

      // ctx has no recordTurn field — optional call ctx.recordTurn?.() must handle undefined
      const ctx = makeCtx();
      // Explicitly confirm recordTurn is absent (makeCtx doesn't set it)
      expect((ctx as { recordTurn?: unknown }).recordTurn).toBeUndefined();

      // Act — should not throw
      const result = await executeReflect(makeStep({ maxIterations: 1 }), ctx);

      // Assert: normal execution, LLM was called, result returned
      expect(runLlmCall).toHaveBeenCalledTimes(1);
      expect(result.output).toMatchObject({ stopReason: 'max_iterations' });
    });

    it('filter: mixed kinds in resumeTurns — only reflect entries influence resume state', async () => {
      // Arrange: one agent_call turn (should be filtered) + one reflect turn
      const priorTurns = [
        {
          kind: 'agent_call' as const,
          index: 0,
          assistantContent: 'x',
          tokensUsed: 50,
          costUsd: 0.005,
        },
        {
          kind: 'reflect' as const,
          iteration: 0,
          draft: 'r0',
          converged: false,
          tokensUsed: 12,
          costUsd: 0.012,
        },
      ];

      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'No further changes',
        tokensUsed: 3,
        costUsd: 0.003,
        model: 'm',
      });

      const ctx = makeCtx({ resumeTurns: priorTurns });

      // Act
      const result = await executeReflect(makeStep(), ctx);

      // Assert: startIteration=1 (only the reflect turn counted, not agent_call)
      expect(result.output).toMatchObject({ iterations: 2, stopReason: 'converged' });

      // Assert: tokens = only reflect prior (12) + new call (3), NOT 50+12+3
      expect(result.tokensUsed).toBe(15);

      // Assert: LLM received draft from the reflect turn ('r0'), not from agent_call
      const promptPassed = vi.mocked(runLlmCall).mock.calls[0][1].prompt;
      expect(promptPassed).toContain('r0');
    });

    it('filter: only non-reflect kinds in resumeTurns — treated as fresh start', async () => {
      // Arrange: only an orchestrator turn in resumeTurns — no reflect entries
      const priorTurns = [
        {
          kind: 'orchestrator' as const,
          round: 1,
          delegations: [],
          plannerTokensUsed: 20,
          plannerCostUsd: 0.002,
        },
      ];

      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'No further changes',
        tokensUsed: 3,
        costUsd: 0.003,
        model: 'm',
      });

      // Act — fresh-start behaviour: seed from last stepOutput, startIteration=0
      const ctx = makeCtx({ resumeTurns: priorTurns });
      const result = await executeReflect(makeStep(), ctx);

      // Assert: no priors influenced the run — LLM was called (no short-circuit)
      expect(runLlmCall).toHaveBeenCalledTimes(1);

      // Assert: tokens = only this new call (no orchestrator tokens rolled in)
      expect(result.tokensUsed).toBe(3);

      // Assert: prompt included the step seed ('initial draft'), not from orchestrator turn
      const promptPassed = vi.mocked(runLlmCall).mock.calls[0][1].prompt;
      expect(promptPassed).toContain('initial draft');
    });

    it('iterations counter on resume: 2 prior turns + 1 new non-converging call = 3 total iterations', async () => {
      // Arrange: 2 prior turns (last.iteration=1), 1 new non-converging call
      // maxIterations=3 so the loop runs once (i=2) then stops at max
      const priorTurns = [
        {
          kind: 'reflect' as const,
          iteration: 0,
          draft: 'p0',
          converged: false,
          tokensUsed: 5,
          costUsd: 0.005,
        },
        {
          kind: 'reflect' as const,
          iteration: 1,
          draft: 'p1',
          converged: false,
          tokensUsed: 5,
          costUsd: 0.005,
        },
      ];

      vi.mocked(runLlmCall).mockResolvedValueOnce({
        content: 'still more work to do',
        tokensUsed: 5,
        costUsd: 0.005,
        model: 'm',
      });

      const ctx = makeCtx({ resumeTurns: priorTurns });

      // Act: maxIterations=3, startIteration=2, loop runs i=2 → iterations=i+1=3
      const result = await executeReflect(makeStep({ maxIterations: 3 }), ctx);

      // Assert: loop ran once at i=2 → final iterations count = 3
      expect(result.output).toMatchObject({ iterations: 3, stopReason: 'max_iterations' });
      expect(runLlmCall).toHaveBeenCalledTimes(1);
    });
  });
});
