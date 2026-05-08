/**
 * Tests for `lib/orchestration/engine/executors/orchestrator.ts`.
 *
 * Covers:
 *   - Happy path: single round with final answer
 *   - Multi-round: planner delegates then synthesizes
 *   - Selection mode 'all': fan-out to every agent
 *   - Missing plannerPrompt: ZodError (schema rejects empty plannerPrompt before executor guard reaches it)
 *   - Empty availableAgentSlugs: ZodError (schema rejects empty availableAgentSlugs before executor guard reaches it);
 *     configured agents all inactive → ExecutorError('no_agents_available')
 *   - Agent not found by planner: skipped, planner informed
 *   - Agent call failure: included in results
 *   - Max rounds exhausted: partial results with stopReason
 *   - Budget exceeded: partial results with stopReason
 *   - Invalid planner JSON: retry then fail
 *   - Cost rollup: planner + delegation costs
 *   - Recursion depth: agentCallDepth incremented
 *
 * @see lib/orchestration/engine/executors/orchestrator.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  runLlmCall: vi.fn(),
  interpolatePrompt: vi.fn((s: string) => s),
}));

vi.mock('@/lib/orchestration/engine/executors/agent-call', () => ({
  executeAgentCall: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeOrchestrator } from '@/lib/orchestration/engine/executors/orchestrator';
import { prisma } from '@/lib/db/client';
import { runLlmCall, interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { executeAgentCall } from '@/lib/orchestration/engine/executors/agent-call';
import type { WorkflowStep, OrchestratorTurn, TurnEntry } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { query: 'Research AI trends' },
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
      withContext: vi.fn().mockReturnThis(),
    } as unknown as ExecutionContext['logger'],
    ...overrides,
  };
}

function makeStep(configOverrides?: Record<string, unknown>): WorkflowStep {
  return {
    id: 'step_orch',
    name: 'Test Orchestrator',
    type: 'orchestrator',
    config: {
      plannerPrompt: 'Coordinate research across specialist agents.',
      availableAgentSlugs: ['researcher', 'analyst'],
      ...configOverrides,
    },
    nextSteps: [],
  };
}

const MOCK_AGENTS = [
  { slug: 'researcher', name: 'Researcher', description: 'Finds information' },
  { slug: 'analyst', name: 'Analyst', description: 'Analyzes data' },
];

function makePlannerResponse(data: {
  delegations?: Array<{ agentSlug: string; message: string }>;
  finalAnswer?: string;
  reasoning?: string;
}): { content: string; tokensUsed: number; costUsd: number; model: string } {
  return {
    content: JSON.stringify({
      delegations: data.delegations ?? [],
      finalAnswer: data.finalAnswer,
      reasoning: data.reasoning,
    }),
    tokensUsed: 200,
    costUsd: 0.005,
    model: 'gpt-4o',
  };
}

function setupDefaultMocks(): void {
  vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(MOCK_AGENTS as never);
  vi.mocked(interpolatePrompt).mockImplementation((s: string) => s);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeOrchestrator', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('happy path: single round with final answer', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({
        finalAnswer: 'AI trends are growing rapidly.',
        reasoning: 'Sufficient context from input.',
      })
    );

    const result = await executeOrchestrator(makeStep(), makeCtx());

    expect(result.output).toMatchObject({
      finalAnswer: 'AI trends are growing rapidly.',
      stopReason: 'final_answer',
      totalDelegations: 0,
    });
    expect(result.tokensUsed).toBe(200);
    expect(result.costUsd).toBe(0.005);
    expect(executeAgentCall).not.toHaveBeenCalled();
  });

  it('multi-round: delegates in round 1, returns answer in round 2', async () => {
    // Round 1: planner delegates
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({
        delegations: [
          { agentSlug: 'researcher', message: 'Find AI market data' },
          { agentSlug: 'analyst', message: 'Analyze growth patterns' },
        ],
        reasoning: 'Need specialist input first.',
      })
    );

    vi.mocked(executeAgentCall)
      .mockResolvedValueOnce({ output: 'Market data: $500B', tokensUsed: 300, costUsd: 0.01 })
      .mockResolvedValueOnce({ output: 'Growth: 25% YoY', tokensUsed: 250, costUsd: 0.008 });

    // Round 2: planner synthesizes
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({
        finalAnswer: 'AI market is $500B growing 25% YoY.',
      })
    );

    const result = await executeOrchestrator(makeStep(), makeCtx());

    expect(result.output).toMatchObject({
      finalAnswer: 'AI market is $500B growing 25% YoY.',
      stopReason: 'final_answer',
      totalDelegations: 2,
    });
    // 2 planner calls + 2 agent calls
    expect(result.tokensUsed).toBe(200 + 300 + 250 + 200);
    expect(result.costUsd).toBeCloseTo(0.005 + 0.01 + 0.008 + 0.005);
    expect(runLlmCall).toHaveBeenCalledTimes(2);
    expect(executeAgentCall).toHaveBeenCalledTimes(2);
  });

  it('selection mode "all": fans out to every agent', async () => {
    // Round 1: fan-out to all agents
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ delegations: [] }) // delegations ignored in 'all' mode
    );

    vi.mocked(executeAgentCall)
      .mockResolvedValueOnce({ output: 'Researcher result', tokensUsed: 100, costUsd: 0.003 })
      .mockResolvedValueOnce({ output: 'Analyst result', tokensUsed: 100, costUsd: 0.003 });

    // Round 2: planner synthesizes
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ finalAnswer: 'Combined result.' })
    );

    const result = await executeOrchestrator(makeStep({ selectionMode: 'all' }), makeCtx());

    expect(result.output).toMatchObject({
      finalAnswer: 'Combined result.',
      stopReason: 'final_answer',
      totalDelegations: 2,
    });
    expect(executeAgentCall).toHaveBeenCalledTimes(2);
  });

  it('throws ZodError when plannerPrompt is empty (schema rejects before executor)', async () => {
    await expect(executeOrchestrator(makeStep({ plannerPrompt: '' }), makeCtx())).rejects.toThrow();

    // Zod validation fires first — the schema requires min(1)
    await expect(
      executeOrchestrator(makeStep({ plannerPrompt: '' }), makeCtx())
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('throws ZodError when availableAgentSlugs is empty (schema rejects before executor)', async () => {
    await expect(
      executeOrchestrator(makeStep({ availableAgentSlugs: [] }), makeCtx())
    ).rejects.toThrow();

    await expect(
      executeOrchestrator(makeStep({ availableAgentSlugs: [] }), makeCtx())
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('throws ExecutorError when no configured agents are active', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([] as never);

    await expect(executeOrchestrator(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'no_agents_available',
    });
  });

  it('skips unavailable agents selected by planner', async () => {
    // Planner selects a non-existent agent
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({
        delegations: [
          { agentSlug: 'non-existent', message: 'Do something' },
          { agentSlug: 'researcher', message: 'Research this' },
        ],
      })
    );

    vi.mocked(executeAgentCall).mockResolvedValueOnce({
      output: 'Research done',
      tokensUsed: 100,
      costUsd: 0.003,
    });

    // Round 2: final answer
    vi.mocked(runLlmCall).mockResolvedValueOnce(makePlannerResponse({ finalAnswer: 'Done.' }));

    const result = await executeOrchestrator(makeStep(), makeCtx());

    // Only 1 delegation (non-existent was filtered out)
    expect(result.output).toMatchObject({ totalDelegations: 1 });
    expect(executeAgentCall).toHaveBeenCalledTimes(1);
  });

  it('includes agent call failures in results', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({
        delegations: [{ agentSlug: 'researcher', message: 'Do work' }],
      })
    );

    vi.mocked(executeAgentCall).mockRejectedValueOnce(new Error('Provider timeout'));

    // Round 2: planner sees the error and returns answer
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ finalAnswer: 'Partial answer despite error.' })
    );

    const result = await executeOrchestrator(makeStep(), makeCtx());

    const rounds = (result.output as Record<string, unknown>).rounds as Array<
      Record<string, unknown>
    >;
    const firstRound = rounds[0];
    const delegations = firstRound.delegations as Array<Record<string, unknown>>;
    expect(delegations[0]).toMatchObject({
      agentSlug: 'researcher',
      error: 'Provider timeout',
    });
  });

  it('returns partial results with stopReason "max_rounds" when exhausted', async () => {
    // Every round delegates but never returns finalAnswer
    vi.mocked(runLlmCall).mockResolvedValue(
      makePlannerResponse({
        delegations: [{ agentSlug: 'researcher', message: 'Keep going' }],
      })
    );

    vi.mocked(executeAgentCall).mockResolvedValue({
      output: 'Still working',
      tokensUsed: 50,
      costUsd: 0.001,
    });

    const result = await executeOrchestrator(makeStep({ maxRounds: 2 }), makeCtx());

    expect(result.output).toMatchObject({
      finalAnswer: null,
      stopReason: 'max_rounds',
      totalDelegations: 2,
    });
  });

  it('returns partial results with stopReason "budget_exceeded"', async () => {
    vi.mocked(runLlmCall).mockResolvedValue(
      makePlannerResponse({
        delegations: [{ agentSlug: 'researcher', message: 'Research' }],
      })
    );

    // First delegation costs more than the budget
    vi.mocked(executeAgentCall).mockResolvedValue({
      output: 'Expensive result',
      tokensUsed: 1000,
      costUsd: 1.0,
    });

    const result = await executeOrchestrator(makeStep({ budgetLimitUsd: 0.5 }), makeCtx());

    expect(result.output).toMatchObject({
      stopReason: 'budget_exceeded',
    });
  });

  it('retries on invalid planner JSON then throws on second failure', async () => {
    vi.mocked(runLlmCall)
      .mockResolvedValueOnce({
        content: 'not valid json {{{',
        tokensUsed: 100,
        costUsd: 0.002,
        model: 'gpt-4o',
      })
      .mockResolvedValueOnce({
        content: 'still not json!!!',
        tokensUsed: 100,
        costUsd: 0.002,
        model: 'gpt-4o',
      });

    await expect(executeOrchestrator(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'planner_parse_failed',
    });

    // Two LLM calls: original + retry
    expect(runLlmCall).toHaveBeenCalledTimes(2);
  });

  it('accumulates cost from planner + all delegations', async () => {
    vi.mocked(runLlmCall)
      .mockResolvedValueOnce(
        makePlannerResponse({
          delegations: [
            { agentSlug: 'researcher', message: 'Task A' },
            { agentSlug: 'analyst', message: 'Task B' },
          ],
        })
      )
      .mockResolvedValueOnce(makePlannerResponse({ finalAnswer: 'Complete.' }));

    vi.mocked(executeAgentCall)
      .mockResolvedValueOnce({ output: 'A result', tokensUsed: 400, costUsd: 0.02 })
      .mockResolvedValueOnce({ output: 'B result', tokensUsed: 300, costUsd: 0.015 });

    const result = await executeOrchestrator(makeStep(), makeCtx());

    // Planner: 200+200 tokens, 0.005+0.005 cost
    // Delegations: 400+300 tokens, 0.02+0.015 cost
    expect(result.tokensUsed).toBe(200 + 400 + 300 + 200);
    expect(result.costUsd).toBeCloseTo(0.005 + 0.02 + 0.015 + 0.005);
  });

  it('increments agentCallDepth before delegating', async () => {
    vi.mocked(runLlmCall)
      .mockResolvedValueOnce(
        makePlannerResponse({
          delegations: [{ agentSlug: 'researcher', message: 'Do work' }],
        })
      )
      .mockResolvedValueOnce(makePlannerResponse({ finalAnswer: 'Done.' }));

    vi.mocked(executeAgentCall).mockResolvedValueOnce({
      output: 'Result',
      tokensUsed: 100,
      costUsd: 0.003,
    });

    const ctx = makeCtx({ variables: { agentCallDepth: 1 } });
    await executeOrchestrator(makeStep(), ctx);

    // Verify executeAgentCall was called with context that has incremented depth
    const callArgs = vi.mocked(executeAgentCall).mock.calls[0];
    const passedCtx = callArgs[1] as ExecutionContext;
    expect(passedCtx.variables.agentCallDepth).toBe(2);
  });

  it('stops with "timeout" when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    // Planner would return delegations, but abort should be checked first
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({
        delegations: [{ agentSlug: 'researcher', message: 'Research' }],
      })
    );

    const result = await executeOrchestrator(makeStep(), makeCtx({ signal: controller.signal }));

    expect(result.output).toMatchObject({
      stopReason: 'timeout',
      totalDelegations: 0,
    });
    // No LLM calls should happen since abort is checked before calling planner
    expect(runLlmCall).not.toHaveBeenCalled();
  });

  it('stops with "timeout" when timeoutMs is exceeded between rounds', async () => {
    // Use the minimum valid timeout (5000ms) and mock Date.now to simulate elapsed time
    const step = makeStep({ timeoutMs: 5000 });

    // Mock Date.now: first two calls return startTime (capture + first check),
    // all subsequent calls return past the timeout.
    // Note: vi.useFakeTimers() is NOT used here because the orchestrator's Promise
    // scheduling relies on real timers resolving (await runLlmCall requires the
    // microtask queue to flush). Fake timers with the default scheduler would
    // deadlock waiting for the await to settle.
    // The magic `2` is stable because:
    //   callCount===1: Date.now() captured as `startTime` at the top of executeOrchestrator.
    //   callCount===2: elapsed check at the top of the round-0 loop iteration → within timeout.
    //   callCount===3+: elapsed check at the top of round-1 iteration → past timeout, loop exits.
    let callCount = 0;
    const startTime = 1000000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      return callCount <= 2 ? startTime : startTime + 6000;
    });

    // Round 1: planner delegates
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({
        delegations: [{ agentSlug: 'researcher', message: 'Research' }],
      })
    );

    vi.mocked(executeAgentCall).mockResolvedValueOnce({
      output: 'Done',
      tokensUsed: 100,
      costUsd: 0.003,
    });

    const result = await executeOrchestrator(step, makeCtx());

    expect(result.output).toMatchObject({
      stopReason: 'timeout',
    });
    // Planner was called once (round 0), but should not be called for round 1
    expect(runLlmCall).toHaveBeenCalledTimes(1);

    dateNowSpy.mockRestore();
  });

  it('stops with "budget_exceeded" when workflow-level budget is exceeded', async () => {
    // Round 1: planner delegates
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({
        delegations: [{ agentSlug: 'researcher', message: 'Research' }],
      })
    );

    // Delegation costs more than the workflow budget allows
    vi.mocked(executeAgentCall).mockResolvedValueOnce({
      output: 'Result',
      tokensUsed: 100,
      costUsd: 0.5,
    });

    // Workflow-level budget is on the context, not the step config
    // ctx.totalCostUsd (already spent) + step cost should exceed budgetLimitUsd
    const result = await executeOrchestrator(
      makeStep(),
      makeCtx({ budgetLimitUsd: 0.1, totalCostUsd: 0 })
    );

    expect(result.output).toMatchObject({
      stopReason: 'budget_exceeded',
    });
  });

  it('stops with "no_delegations" when planner returns empty delegations', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce(makePlannerResponse({ delegations: [] }));

    const result = await executeOrchestrator(makeStep(), makeCtx());

    expect(result.output).toMatchObject({
      stopReason: 'no_delegations',
      totalDelegations: 0,
    });
  });

  it('planner JSON parse retry: first parse fails, retry succeeds with final answer', async () => {
    // Arrange — first response is invalid JSON; retry returns valid JSON with a final answer
    vi.mocked(runLlmCall)
      .mockResolvedValueOnce({
        content: 'not valid json {{{',
        tokensUsed: 100,
        costUsd: 0.002,
        model: 'gpt-4o',
      })
      .mockResolvedValueOnce(
        makePlannerResponse({
          finalAnswer: 'Recovered answer after retry.',
          reasoning: 'The retry succeeded.',
        })
      );

    // Act
    const result = await executeOrchestrator(makeStep(), makeCtx());

    // Assert — executor recovered and used the retried planner response
    expect(result.output).toMatchObject({
      finalAnswer: 'Recovered answer after retry.',
      stopReason: 'final_answer',
    });
    // Two LLM calls: original (invalid JSON) + retry (valid JSON)
    expect(runLlmCall).toHaveBeenCalledTimes(2);
    // Cost from both the invalid-JSON response and the retry are accumulated
    expect(result.costUsd).toBeCloseTo(0.002 + 0.005);
    expect(result.tokensUsed).toBe(100 + 200);
  });
});

// ─── Multi-turn checkpoint resume ────────────────────────────────────────────

describe('multi-turn checkpoint resume', () => {
  // Nested beforeEach ensures mocks are reset to known defaults before each
  // resume test, preventing cross-describe contamination (gotcha #22).
  beforeEach(() => {
    vi.mocked(runLlmCall).mockReset();
    vi.mocked(executeAgentCall).mockReset();
    vi.mocked(interpolatePrompt).mockReset();
    vi.mocked(prisma.aiAgent.findMany).mockReset();

    // Re-apply defaults after reset
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(MOCK_AGENTS as never);
    vi.mocked(interpolatePrompt).mockImplementation((s: string) => s);
  });

  it('fresh start: no resumeTurns, loop begins at round 0, recordTurn fires once for final-answer round', async () => {
    // Arrange — no prior turns, 1-round scenario
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ finalAnswer: 'Fresh start answer.', reasoning: 'Enough context.' })
    );

    // Act
    const result = await executeOrchestrator(makeStep(), makeCtx({ recordTurn }));

    // Assert — loop began at round 0, one recordTurn call for the completed round
    expect(result.output).toMatchObject({
      finalAnswer: 'Fresh start answer.',
      stopReason: 'final_answer',
    });
    // recordTurn fires exactly once, for round 1
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'orchestrator',
        round: 1,
        finalAnswer: 'Fresh start answer.',
      })
    );
    // Planner was called exactly once (no prior rounds to skip)
    expect(runLlmCall).toHaveBeenCalledTimes(1);
  });

  it('resume from 2 prior rounds: starts at round 2, accumulates prior tokens, round 3 planner called once', async () => {
    // Arrange — 2 prior turns, round 3 planner returns final answer
    const prior1: OrchestratorTurn = {
      kind: 'orchestrator',
      round: 1,
      plannerReasoning: 'r1',
      delegations: [{ agentSlug: 'a', message: 'm', output: 'o', tokensUsed: 100, costUsd: 0.01 }],
      plannerTokensUsed: 50,
      plannerCostUsd: 0.005,
    };
    const prior2: OrchestratorTurn = {
      kind: 'orchestrator',
      round: 2,
      plannerReasoning: 'r2',
      delegations: [
        { agentSlug: 'b', message: 'm2', output: 'o2', tokensUsed: 80, costUsd: 0.008 },
      ],
      plannerTokensUsed: 60,
      plannerCostUsd: 0.006,
    };

    // Explicit planner values controlled by this test so token/cost assertions can
    // be derived rather than hard-coded (Finding 15 — literal-sum brittleness).
    const plannerTokens = 200;
    const plannerCostUsd = 0.005;
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: JSON.stringify({
        delegations: [],
        finalAnswer: 'Resume final answer.',
        reasoning: 'Round 3 done.',
      }),
      tokensUsed: plannerTokens,
      costUsd: plannerCostUsd,
      model: 'gpt-4o',
    });

    // Act
    const result = await executeOrchestrator(
      makeStep(),
      makeCtx({ resumeTurns: [prior1, prior2] })
    );

    // Assert — loop resumed at round 2 (0-indexed), 3 rounds total in output
    const output = result.output as Record<string, unknown>;
    expect((output.rounds as unknown[]).length).toBe(3);
    expect(output.finalAnswer).toBe('Resume final answer.');

    // Token total derived from fixtures + controlled planner mock value
    const priorTokens =
      prior1.plannerTokensUsed +
      prior1.delegations.reduce((s, d) => s + d.tokensUsed, 0) +
      prior2.plannerTokensUsed +
      prior2.delegations.reduce((s, d) => s + d.tokensUsed, 0);
    expect(result.tokensUsed).toBe(priorTokens + plannerTokens);
    // Cost total derived from fixtures + controlled planner mock value
    const priorCost =
      prior1.plannerCostUsd +
      prior1.delegations.reduce((s, d) => s + d.costUsd, 0) +
      prior2.plannerCostUsd +
      prior2.delegations.reduce((s, d) => s + d.costUsd, 0);
    expect(result.costUsd).toBeCloseTo(priorCost + plannerCostUsd);

    // Planner was called exactly once (for round 3 only — priors were restored)
    expect(runLlmCall).toHaveBeenCalledTimes(1);
  });

  it('resume short-circuit: last prior turn has finalAnswer, runLlmCall NOT called', async () => {
    // Arrange — last prior turn has finalAnswer set
    const prior1: OrchestratorTurn = {
      kind: 'orchestrator',
      round: 1,
      plannerReasoning: 'r1',
      delegations: [{ agentSlug: 'a', message: 'm', output: 'o', tokensUsed: 100, costUsd: 0.01 }],
      plannerTokensUsed: 50,
      plannerCostUsd: 0.005,
    };
    const prior2: OrchestratorTurn = {
      kind: 'orchestrator',
      round: 2,
      plannerReasoning: 'r2',
      delegations: [],
      plannerTokensUsed: 60,
      plannerCostUsd: 0.006,
      finalAnswer: 'cached answer',
    };

    // Act
    const result = await executeOrchestrator(
      makeStep(),
      makeCtx({ resumeTurns: [prior1, prior2] })
    );

    // Assert — planner NOT called; cached answer returned immediately
    // Per gotcha #23: prefer not.toHaveBeenCalled() over mockImplementation(throw)
    expect(runLlmCall).not.toHaveBeenCalled();

    const output = result.output as Record<string, unknown>;
    expect(output.finalAnswer).toBe('cached answer');
    expect(output.stopReason).toBe('final_answer');

    // Rounds shape matches the 2 priors exactly
    expect((output.rounds as unknown[]).length).toBe(2);

    // Token/cost totals are sum of priors only — no new planner cost added
    expect(result.tokensUsed).toBe(50 + 100 + 60 + 0); // planner1 + delegation1 + planner2 + delegations2(empty)
    expect(result.costUsd).toBeCloseTo(0.005 + 0.01 + 0.006 + 0);
  });

  it('filter: mixed kinds in resumeTurns — only orchestrator entries influence state', async () => {
    // Arrange — resumeTurns contains reflect and agent_call entries mixed with one orchestrator entry
    const reflectEntry: TurnEntry = {
      kind: 'reflect',
      iteration: 0,
      draft: 'initial draft',
      converged: false,
      tokensUsed: 999,
      costUsd: 0.999,
    };
    const agentCallEntry: TurnEntry = {
      kind: 'agent_call',
      index: 0,
      assistantContent: 'assistant text',
      tokensUsed: 888,
      costUsd: 0.888,
    };
    const orchEntry: OrchestratorTurn = {
      kind: 'orchestrator',
      round: 1,
      plannerReasoning: 'orch r1',
      delegations: [
        {
          agentSlug: 'researcher',
          message: 'msg',
          output: 'result',
          tokensUsed: 120,
          costUsd: 0.012,
        },
      ],
      plannerTokensUsed: 55,
      plannerCostUsd: 0.0055,
    };

    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ finalAnswer: 'Mixed kinds answer.' })
    );

    // Act
    const result = await executeOrchestrator(
      makeStep(),
      makeCtx({ resumeTurns: [reflectEntry, orchEntry, agentCallEntry] })
    );

    // Assert — only the orchestrator entry affected the accumulated cost
    // Reflect and agent_call token costs should NOT be included
    expect(result.tokensUsed).toBe(
      55 +
        120 + // orchEntry planner + delegation
        200 // new planner round
    );
    expect(result.costUsd).toBeCloseTo(0.0055 + 0.012 + 0.005);

    // Loop started at round 1 (1 prior orch turn), new round is round 2
    const output = result.output as Record<string, unknown>;
    expect((output.rounds as unknown[]).length).toBe(2);

    // Planner called exactly once (for the new round only)
    expect(runLlmCall).toHaveBeenCalledTimes(1);
  });

  it('recordTurn called for final-answer round with finalAnswer field populated', async () => {
    // Arrange — 1-round scenario where planner returns final answer
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ finalAnswer: 'Final answer done.', reasoning: 'All good.' })
    );

    // Act
    await executeOrchestrator(makeStep(), makeCtx({ recordTurn }));

    // Assert — recordTurn called once with finalAnswer field
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ finalAnswer: 'Final answer done.' })
    );
  });

  it('recordTurn called for no-delegations round with NO finalAnswer field', async () => {
    // Arrange — planner returns no delegations and no finalAnswer
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ delegations: [], reasoning: 'nothing to do' })
      // no finalAnswer property in makePlannerResponse when not passed
    );

    // Act
    const result = await executeOrchestrator(makeStep(), makeCtx({ recordTurn }));

    // Assert — stopReason is no_delegations, not final_answer
    const output = result.output as Record<string, unknown>;
    expect(output.stopReason).toBe('no_delegations');

    // recordTurn called once, WITHOUT a finalAnswer field
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(recordTurn).not.toHaveBeenCalledWith(
      expect.objectContaining({ finalAnswer: expect.anything() })
    );
  });

  it('recordTurn called for normal-completion round with delegations and NO finalAnswer; then final-answer round has finalAnswer', async () => {
    // Arrange — round 1 delegates, round 2 has final answer
    const recordTurn = vi.fn().mockResolvedValue(undefined);

    // Round 1: planner delegates
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({
        delegations: [{ agentSlug: 'researcher', message: 'Research this' }],
        reasoning: 'need more info',
      })
    );
    vi.mocked(executeAgentCall).mockResolvedValueOnce({
      output: 'research result',
      tokensUsed: 150,
      costUsd: 0.015,
    });

    // Round 2: planner returns final answer
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ finalAnswer: 'done', reasoning: 'complete' })
    );

    // Act
    await executeOrchestrator(makeStep(), makeCtx({ recordTurn }));

    // Assert — two recordTurn calls total
    expect(recordTurn).toHaveBeenCalledTimes(2);

    // First call (round 1): has delegations, NO finalAnswer
    const firstCall = recordTurn.mock.calls[0][0] as Record<string, unknown>;
    const firstDelegations = firstCall.delegations as unknown[];
    expect(firstDelegations.length).toBeGreaterThan(0);
    expect(firstCall).not.toHaveProperty('finalAnswer');

    // Second call (round 2): has finalAnswer
    expect(recordTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ finalAnswer: 'done' }));
  });

  it('recordTurn absent: executor completes without throwing', async () => {
    // Arrange — ctx has no recordTurn property
    const ctxWithoutRecordTurn = makeCtx();
    // Confirm recordTurn is absent from the context
    expect(ctxWithoutRecordTurn.recordTurn).toBeUndefined();

    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ finalAnswer: 'No recorder needed.', reasoning: 'Done.' })
    );

    // Act — should not throw even though ctx.recordTurn is undefined
    const result = await executeOrchestrator(makeStep(), ctxWithoutRecordTurn);

    // Assert — normal completion
    const output = result.output as Record<string, unknown>;
    expect(output.finalAnswer).toBe('No recorder needed.');
    expect(output.stopReason).toBe('final_answer');
  });

  it('recordTurn fires BEFORE the break on final-answer path: exactly one planner call and one recordTurn call', async () => {
    // Arrange — 1-round final-answer scenario
    // If the break were BEFORE recordTurn, the turn would not be recorded.
    // We verify recordTurn is called once (it was called), and runLlmCall is
    // called only once (the loop did NOT continue past the break).
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ finalAnswer: 'Answer before break.', reasoning: 'Done.' })
    );

    // Act
    const result = await executeOrchestrator(makeStep(), makeCtx({ recordTurn }));

    // Assert — planner called exactly once (break was reached)
    expect(runLlmCall).toHaveBeenCalledTimes(1);

    // recordTurn was called exactly once (BEFORE the break, not skipped)
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ finalAnswer: 'Answer before break.' })
    );

    // The result confirms finalAnswer was set (loop didn't continue past break)
    expect((result.output as Record<string, unknown>).finalAnswer).toBe('Answer before break.');
  });

  it('recordTurn fires BEFORE the break on no-delegations path: exactly one planner call and one recordTurn call', async () => {
    // Arrange — planner returns empty delegations (triggers no_delegations break)
    // If recordTurn were AFTER the break, it would not be called.
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ delegations: [], reasoning: 'No work to delegate.' })
    );

    // Act
    const result = await executeOrchestrator(makeStep(), makeCtx({ recordTurn }));

    // Assert — planner called exactly once (no second round)
    expect(runLlmCall).toHaveBeenCalledTimes(1);
    // No agent calls (empty delegations)
    expect(executeAgentCall).not.toHaveBeenCalled();

    // recordTurn was called exactly once (BEFORE the break, not skipped)
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'orchestrator', round: 1, delegations: [] })
    );

    // Confirms the no-delegations path was taken
    expect((result.output as Record<string, unknown>).stopReason).toBe('no_delegations');
  });

  it('resume + normal round: recordTurn fires only for the new round, not restored prior rounds', async () => {
    // Arrange — 1 prior turn restored from resumeTurns; round 2 runs new planner
    const prior1: OrchestratorTurn = {
      kind: 'orchestrator',
      round: 1,
      plannerReasoning: 'prior reasoning',
      delegations: [
        {
          agentSlug: 'researcher',
          message: 'prior msg',
          output: 'prior out',
          tokensUsed: 50,
          costUsd: 0.005,
        },
      ],
      plannerTokensUsed: 40,
      plannerCostUsd: 0.004,
    };

    const recordTurn = vi.fn().mockResolvedValue(undefined);

    // Round 2: planner returns final answer
    vi.mocked(runLlmCall).mockResolvedValueOnce(
      makePlannerResponse({ finalAnswer: 'New round answer.', reasoning: 'Resuming.' })
    );

    // Act
    const result = await executeOrchestrator(
      makeStep(),
      makeCtx({ resumeTurns: [prior1], recordTurn })
    );

    // Assert — recordTurn called exactly ONCE (for the new round 2 only, NOT for restored round 1)
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'orchestrator', round: 2, finalAnswer: 'New round answer.' })
    );

    // 2 rounds total in output (1 restored + 1 new)
    const output = result.output as Record<string, unknown>;
    expect((output.rounds as unknown[]).length).toBe(2);
    expect(output.finalAnswer).toBe('New round answer.');
  });
});
