/**
 * Unit Tests: estimateWorkflowCost (generic workflow cost estimator)
 *
 * Test Coverage:
 * - Heuristic counts LLM-producing steps from the workflow definition
 * - Heuristic adapts to workflows of different shapes (more / fewer steps)
 * - Supervisor step add-on only fires when the workflow defines one
 * - Empirical path activates with 3+ matching past runs
 * - Empirical reprices using the current chat default, not the historical model
 * - Past runs are split by supervisor *step type* (not a hard-coded step id)
 * - Past-runs query failure falls back to heuristic
 * - Workflow without a supervisor step ignores the supervisor toggle
 * - parseInputData handles common list shapes and rejects unrecognised input
 *
 * @see lib/orchestration/cost-estimation/workflow-cost.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (declared before imports per Vitest hoisting) ─────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: { findUnique: vi.fn() },
    aiWorkflowExecution: { findMany: vi.fn() },
    aiCostLog: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTaskOrNull: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/judge-model', () => ({
  JUDGE_MODEL: null as string | null,
}));

import { prisma } from '@/lib/db/client';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import {
  estimateWorkflowCost,
  parseInputData,
  summariseShape,
} from '@/lib/orchestration/cost-estimation/workflow-cost';
import type { WorkflowDefinition, WorkflowStep } from '@/types/orchestration';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const CHAT_MODEL = {
  id: 'claude-sonnet-4-6',
  name: 'Sonnet',
  provider: 'anthropic',
  tier: 'mid' as const,
  inputCostPerMillion: 3,
  outputCostPerMillion: 15,
  maxContext: 200_000,
  supportsTools: true,
};

const HAIKU = {
  id: 'claude-haiku-4-5',
  name: 'Haiku',
  provider: 'anthropic',
  tier: 'budget' as const,
  inputCostPerMillion: 1,
  outputCostPerMillion: 5,
  maxContext: 200_000,
  supportsTools: true,
};

/**
 * Build a minimal workflow definition with the given step types. Each
 * step has the engine-required fields (id, name, type, config,
 * nextSteps) but the config/edges aren't load-bearing for these tests
 * — we just need the schema to validate.
 */
function makeDefinition(stepTypes: string[]): WorkflowDefinition {
  const steps: WorkflowStep[] = stepTypes.map((type, i) => {
    const id = `s${i}`;
    const next = i < stepTypes.length - 1 ? [{ targetStepId: `s${i + 1}` }] : [];
    // Different step types require different minimal configs to satisfy
    // the zod discriminated union — give each one the bare minimum.
    let config: Record<string, unknown> = {};
    if (type === 'llm_call') config = { prompt: 'x' };
    else if (type === 'route')
      config = { classificationPrompt: 'x', routes: [{ label: 'a', value: 'a' }] };
    else if (type === 'agent_call') config = { agentSlug: 'a' };
    else if (type === 'evaluate') config = { rubric: 'x' };
    else if (type === 'guard') config = { rules: 'x' };
    else if (type === 'reflect') config = { critiquePrompt: 'x' };
    else if (type === 'plan') config = { goalPrompt: 'x', allowedStepTypes: ['llm_call'] };
    else if (type === 'orchestrator')
      config = { coordinatorPrompt: 'x', subagents: [{ slug: 'a', role: 'r' }] };
    else if (type === 'supervisor') config = { assessmentCriteria: 'x' };
    else if (type === 'tool_call') config = { capabilitySlug: 'cap' };
    else if (type === 'external_call') config = { url: 'https://example.com', method: 'GET' };
    else if (type === 'send_notification')
      config = { channel: 'email', to: 'x@y.z', subject: 's', bodyTemplate: 't' };
    else if (type === 'rag_retrieve') config = { query: 'x' };
    else if (type === 'human_approval') config = { prompt: 'x' };
    else if (type === 'parallel') config = { branches: ['s0'] };
    else if (type === 'chain') config = {};
    else if (type === 'report') config = { format: 'markdown' };
    return { id, name: id, type: type as never, config, nextSteps: next };
  });
  return {
    steps,
    entryStepId: 's0',
    errorStrategy: 'fail',
  };
}

function mockWorkflow(definition: WorkflowDefinition): void {
  vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
    publishedVersion: { snapshot: definition },
  } as never);
}

function mockChatDefault(modelId: string | null): void {
  vi.mocked(getDefaultModelForTaskOrNull).mockResolvedValue(modelId);
}

function mockModelLookup(map: Record<string, typeof CHAT_MODEL | typeof HAIKU>): void {
  vi.mocked(getModel).mockImplementation((id: string) => map[id]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([]);
  vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([]);
  mockChatDefault(CHAT_MODEL.id);
  mockModelLookup({ [CHAT_MODEL.id]: CHAT_MODEL, [HAIKU.id]: HAIKU });
});

// ─── Heuristic mode ───────────────────────────────────────────────────────

describe('estimateWorkflowCost — heuristic mode', () => {
  it('counts LLM-producing steps from the workflow definition', async () => {
    // 3 LLM-producing steps: llm_call, evaluate, guard.
    // tool_call + send_notification are non-LLM and excluded.
    mockWorkflow(
      makeDefinition(['llm_call', 'tool_call', 'evaluate', 'guard', 'send_notification'])
    );

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });

    expect(estimate.basedOn).toBe('heuristic');
    expect(estimate.llmStepCount).toBe(3);
    expect(estimate.workflowHasSupervisor).toBe(false);
    // 3 LLM steps × 3_000 input + 1_000 output, no items, no supervisor.
    //   input  = 9_000 → 9k/1M*3 = $0.027
    //   output = 3_000 → 3k/1M*15 = $0.045
    //   total = $0.072
    expect(estimate.midUsd).toBeCloseTo(0.072, 4);
  });

  it('scales the heuristic with itemCount when provided', async () => {
    mockWorkflow(makeDefinition(['llm_call', 'evaluate']));

    const noItems = await estimateWorkflowCost({ workflowId: 'wf-1' });
    const fiveItems = await estimateWorkflowCost({ workflowId: 'wf-1', itemCount: 5 });

    // Per-item heuristic: 800 input + 300 output × 5 items added to each.
    // The delta should be: 5 × (800/1M*3 + 300/1M*15) = 5 × ($0.0024 + $0.0045) = $0.0345
    expect(fiveItems.midUsd - noItems.midUsd).toBeCloseTo(0.0345, 4);
  });

  it('detects a supervisor step and adds judge-model cost when requested', async () => {
    mockWorkflow(makeDefinition(['llm_call', 'supervisor', 'send_notification']));

    const withSup = await estimateWorkflowCost({ workflowId: 'wf-1', supervisor: true });
    const withoutSup = await estimateWorkflowCost({ workflowId: 'wf-1', supervisor: false });

    expect(withSup.workflowHasSupervisor).toBe(true);
    expect(withSup.judgeModelUsed).toBe(CHAT_MODEL.id); // JUDGE_MODEL is null
    expect(withoutSup.judgeModelUsed).toBeNull();
    // Supervisor adds: 18_000/1M*3 + 2_500/1M*15 = $0.054 + $0.0375 = $0.0915
    expect(withSup.midUsd - withoutSup.midUsd).toBeCloseTo(0.0915, 3);
  });

  it('ignores the supervisor toggle when the workflow has no supervisor step', async () => {
    mockWorkflow(makeDefinition(['llm_call', 'evaluate']));

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1', supervisor: true });

    expect(estimate.workflowHasSupervisor).toBe(false);
    expect(estimate.judgeModelUsed).toBeNull();
  });

  it('uses the chat default for the supervisor when JUDGE_MODEL is unset', async () => {
    mockWorkflow(makeDefinition(['llm_call', 'supervisor']));
    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1', supervisor: true });
    expect(estimate.judgeModelUsed).toBe(CHAT_MODEL.id);
  });

  it('falls back to a known model id when no chat default is configured', async () => {
    mockChatDefault(null);
    mockWorkflow(makeDefinition(['llm_call']));
    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });
    expect(estimate.modelUsed).toBe(CHAT_MODEL.id);
    expect(estimate.midUsd).toBeGreaterThan(0);
  });

  it('returns a degenerate shape when the workflow has no published version', async () => {
    // findUnique mock is null by default — heuristic should still resolve.
    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });
    expect(estimate.basedOn).toBe('heuristic');
    expect(estimate.llmStepCount).toBe(1); // degenerate floor
    expect(estimate.workflowHasSupervisor).toBe(false);
  });
});

// ─── Empirical mode ───────────────────────────────────────────────────────

interface PastRun {
  executionId: string;
  itemCount: number;
  supervisor: boolean;
  workInput: number;
  workOutput: number;
  supInput?: number;
  supOutput?: number;
  /** Step id to attribute the work tokens to. Default 's0' (non-supervisor). */
  workStepId?: string;
  /** Step id to attribute supervisor tokens to. Must match a step id with type 'supervisor'. */
  supStepId?: string;
}

function seedPastRuns(runs: PastRun[]): void {
  vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue(
    runs.map((r) => ({
      id: r.executionId,
      inputData: {
        modelIds: Array.from({ length: r.itemCount }, (_, i) => `m${i}`),
        __runSupervisor: r.supervisor,
      } as unknown,
    })) as never
  );
  vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue(
    runs.flatMap((r) => {
      const rows: unknown[] = [
        {
          workflowExecutionId: r.executionId,
          inputTokens: r.workInput,
          outputTokens: r.workOutput,
          metadata: { stepId: r.workStepId ?? 's0' },
        },
      ];
      if (r.supervisor && r.supInput && r.supOutput && r.supStepId) {
        rows.push({
          workflowExecutionId: r.executionId,
          inputTokens: r.supInput,
          outputTokens: r.supOutput,
          metadata: { stepId: r.supStepId },
        });
      }
      return rows;
    }) as never
  );
}

describe('estimateWorkflowCost — empirical mode', () => {
  it('switches to empirical when 3+ matching past runs exist', async () => {
    // Workflow: 2 LLM steps (no supervisor) → heuristic = 6_000 in, 2_000 out per run.
    mockWorkflow(makeDefinition(['llm_call', 'evaluate']));
    // Three past runs matching the heuristic exactly → ratio 1.0.
    seedPastRuns([
      { executionId: 'e1', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
      { executionId: 'e2', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
      { executionId: 'e3', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
    ]);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });

    expect(estimate.basedOn).toBe('empirical');
    expect(estimate.sampleSize).toBe(3);
    // 6_000/1M*3 + 2_000/1M*15 = $0.018 + $0.030 = $0.048
    expect(estimate.midUsd).toBeCloseTo(0.048, 3);
  });

  it('reprices using the current chat default, not the historical model', async () => {
    mockWorkflow(makeDefinition(['llm_call', 'evaluate']));
    seedPastRuns([
      { executionId: 'e1', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
      { executionId: 'e2', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
      { executionId: 'e3', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
    ]);

    // Switch the chat default to Haiku.
    mockChatDefault(HAIKU.id);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });
    expect(estimate.basedOn).toBe('empirical');
    expect(estimate.modelUsed).toBe(HAIKU.id);
    // Haiku rates: 6_000/1M*1 + 2_000/1M*5 = $0.006 + $0.010 = $0.016
    expect(estimate.midUsd).toBeCloseTo(0.016, 3);
  });

  it('filters past runs by supervisor toggle when the workflow has a supervisor', async () => {
    mockWorkflow(makeDefinition(['llm_call', 'supervisor']));
    // Three past runs ALL with supervisor=true — should not match a supervisor=false request.
    seedPastRuns([
      {
        executionId: 'e1',
        itemCount: 0,
        supervisor: true,
        workInput: 6_000,
        workOutput: 2_000,
        supInput: 18_000,
        supOutput: 2_500,
        supStepId: 's1',
      },
      {
        executionId: 'e2',
        itemCount: 0,
        supervisor: true,
        workInput: 6_000,
        workOutput: 2_000,
        supInput: 18_000,
        supOutput: 2_500,
        supStepId: 's1',
      },
      {
        executionId: 'e3',
        itemCount: 0,
        supervisor: true,
        workInput: 6_000,
        workOutput: 2_000,
        supInput: 18_000,
        supOutput: 2_500,
        supStepId: 's1',
      },
    ]);

    const noSupRequest = await estimateWorkflowCost({ workflowId: 'wf-1', supervisor: false });
    expect(noSupRequest.basedOn).toBe('heuristic'); // no matching runs
    expect(noSupRequest.sampleSize).toBe(0);
  });

  it('skips supervisor filter when the workflow has no supervisor step', async () => {
    // Workflow without a supervisor step — past runs with supervisor=true
    // should still contribute (the toggle is meaningless for this workflow).
    mockWorkflow(makeDefinition(['llm_call']));
    seedPastRuns([
      { executionId: 'e1', itemCount: 0, supervisor: true, workInput: 3_000, workOutput: 1_000 },
      { executionId: 'e2', itemCount: 0, supervisor: false, workInput: 3_000, workOutput: 1_000 },
      { executionId: 'e3', itemCount: 0, supervisor: true, workInput: 3_000, workOutput: 1_000 },
    ]);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });
    expect(estimate.basedOn).toBe('empirical');
    expect(estimate.sampleSize).toBe(3);
  });

  it('falls back to heuristic when the past-runs query throws', async () => {
    mockWorkflow(makeDefinition(['llm_call']));
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockRejectedValue(new Error('db down'));

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });
    expect(estimate.basedOn).toBe('heuristic');
    expect(estimate.midUsd).toBeGreaterThan(0);
  });
});

// ─── summariseShape ───────────────────────────────────────────────────────

describe('summariseShape', () => {
  it('counts agent_call as 3 LLM steps (tool-iteration multiplier)', () => {
    const def = makeDefinition(['agent_call']);
    const shape = summariseShape(def);
    expect(shape.llmStepCount).toBe(3);
  });

  it('counts reflect as 2 LLM steps (draft + critique)', () => {
    const def = makeDefinition(['reflect']);
    const shape = summariseShape(def);
    expect(shape.llmStepCount).toBe(2);
  });

  it('excludes non-LLM step types from the count', () => {
    const def = makeDefinition(['tool_call', 'external_call', 'send_notification', 'parallel']);
    const shape = summariseShape(def);
    expect(shape.llmStepCount).toBe(0);
  });

  it('collects supervisor step ids separately', () => {
    const def = makeDefinition(['llm_call', 'supervisor', 'supervisor']);
    const shape = summariseShape(def);
    expect(shape.llmStepCount).toBe(1); // supervisors don't count toward LLM step count
    expect(shape.hasSupervisor).toBe(true);
    expect(shape.supervisorStepIds.size).toBe(2);
  });
});

// ─── parseInputData ───────────────────────────────────────────────────────

describe('parseInputData', () => {
  it('extracts itemCount from modelIds (audit convention)', () => {
    expect(parseInputData({ modelIds: ['a', 'b', 'c'] }).itemCount).toBe(3);
  });

  it('also recognises items, inputs, and ids as list fields', () => {
    expect(parseInputData({ items: [1, 2] }).itemCount).toBe(2);
    expect(parseInputData({ inputs: ['x'] }).itemCount).toBe(1);
    expect(parseInputData({ ids: ['a', 'b', 'c', 'd'] }).itemCount).toBe(4);
  });

  it('returns itemCount=0 when no recognisable list field is present', () => {
    expect(parseInputData({ foo: 'bar' }).itemCount).toBe(0);
    expect(parseInputData({}).itemCount).toBe(0);
  });

  it('treats missing __runSupervisor as supervisor=true (engine default)', () => {
    expect(parseInputData({ modelIds: ['a'] }).supervisor).toBe(true);
  });

  it('only the literal boolean false opts the supervisor out', () => {
    expect(parseInputData({ modelIds: ['a'], __runSupervisor: false }).supervisor).toBe(false);
    expect(parseInputData({ modelIds: ['a'], __runSupervisor: 'false' }).supervisor).toBe(true);
    expect(parseInputData({ modelIds: ['a'], __runSupervisor: 0 }).supervisor).toBe(true);
    expect(parseInputData({ modelIds: ['a'], __runSupervisor: null }).supervisor).toBe(true);
  });

  it('returns a zeroed default for non-object inputs', () => {
    expect(parseInputData(null)).toEqual({ itemCount: 0, supervisor: true });
    expect(parseInputData([])).toEqual({ itemCount: 0, supervisor: true });
    expect(parseInputData('string')).toEqual({ itemCount: 0, supervisor: true });
  });
});
