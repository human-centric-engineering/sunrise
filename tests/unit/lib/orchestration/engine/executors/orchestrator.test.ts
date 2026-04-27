/**
 * Tests for `lib/orchestration/engine/executors/orchestrator.ts`.
 *
 * Covers:
 *   - Happy path: single round with final answer
 *   - Multi-round: planner delegates then synthesizes
 *   - Selection mode 'all': fan-out to every agent
 *   - Missing plannerPrompt: throws ExecutorError('missing_planner_prompt')
 *   - Empty availableAgentSlugs: throws ExecutorError('no_agents_available')
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
import type { WorkflowStep } from '@/types/orchestration';
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
    // all subsequent calls return past the timeout
    let callCount = 0;
    const startTime = 1000000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // Call 1: startTime capture, Call 2: round 0 timeout check → both within timeout
      // Call 3+: round 1 timeout check → past timeout
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
