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
    aiAgent: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: vi.fn(),
  refreshFromOpenRouter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/orchestration/llm/model-registry-db-hydrate', () => ({
  hydrateFromDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTaskOrNull: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/judge-model', () => ({
  JUDGE_MODEL: null as string | null,
}));

import { prisma } from '@/lib/db/client';
import { getModel, refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';
import { hydrateFromDb as hydrateModelRegistryFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';
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
  vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
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
  /**
   * Model recorded on the work cost-log row. Defaults to the chat-default
   * (CHAT_MODEL.id) so existing tests stay representative of an unchanged
   * model setup. Override to simulate a model swap.
   */
  workModel?: string;
  /** Same, but for the supervisor cost-log row. */
  supModel?: string;
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
          model: r.workModel ?? CHAT_MODEL.id,
        },
      ];
      if (r.supervisor && r.supInput && r.supOutput && r.supStepId) {
        rows.push({
          workflowExecutionId: r.executionId,
          inputTokens: r.supInput,
          outputTokens: r.supOutput,
          metadata: { stepId: r.supStepId },
          model: r.supModel ?? CHAT_MODEL.id,
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

  it('reprices empirical tokens at the current registry rate when the model is unchanged', async () => {
    // Same modelId in past runs and current shape — fingerprint matches.
    // The registry's per-token rate is the *current* rate, so a price
    // shift on Sonnet propagates immediately. (Realistic scenario:
    // OpenRouter refresh picks up an updated cost from the matrix.)
    mockWorkflow(makeDefinition(['llm_call', 'evaluate']));
    seedPastRuns([
      { executionId: 'e1', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
      { executionId: 'e2', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
      { executionId: 'e3', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
    ]);

    // Halve Sonnet's rates in the registry — modelId unchanged.
    mockModelLookup({
      [CHAT_MODEL.id]: { ...CHAT_MODEL, inputCostPerMillion: 1.5, outputCostPerMillion: 7.5 },
      [HAIKU.id]: HAIKU,
    });

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });
    expect(estimate.basedOn).toBe('empirical');
    expect(estimate.modelUsed).toBe(CHAT_MODEL.id);
    // Halved rates: 6_000/1M*1.5 + 2_000/1M*7.5 = $0.009 + $0.015 = $0.024
    expect(estimate.midUsd).toBeCloseTo(0.024, 3);
  });

  it('falls back to heuristic when the chat default has changed since the past runs', async () => {
    // Past runs all logged Sonnet. We then switch the chat default to
    // Haiku. The current shape resolves each step to Haiku, so the
    // per-step model fingerprint diverges from every past run — there
    // is no way to honestly recycle a Sonnet-run token shape under the
    // new Haiku-or-equivalent assumption, so empirical must stand down.
    mockWorkflow(makeDefinition(['llm_call', 'evaluate']));
    seedPastRuns([
      { executionId: 'e1', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
      { executionId: 'e2', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
      { executionId: 'e3', itemCount: 0, supervisor: false, workInput: 6_000, workOutput: 2_000 },
    ]);
    mockChatDefault(HAIKU.id);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });
    expect(estimate.basedOn).toBe('heuristic');
    expect(estimate.modelUsed).toBe(HAIKU.id);
    // 3 of 3 past runs excluded — note must point at the model change,
    // not at sparse history.
    expect(estimate.notes).toMatch(/different models/i);
  });

  it('falls back to heuristic when a step has been pinned to a different model via modelOverride', async () => {
    // Past runs logged Sonnet on s0. We pin s0 to Haiku — same effect
    // as switching an agent's bound model to a more expensive one.
    // Empirical should stand down even though the *chat default*
    // hasn't moved.
    const def = makeDefinition(['llm_call']);
    def.steps[0].config = { ...def.steps[0].config, modelOverride: HAIKU.id };
    mockWorkflow(def);
    seedPastRuns([
      { executionId: 'e1', itemCount: 0, supervisor: false, workInput: 3_000, workOutput: 1_000 },
      { executionId: 'e2', itemCount: 0, supervisor: false, workInput: 3_000, workOutput: 1_000 },
      { executionId: 'e3', itemCount: 0, supervisor: false, workInput: 3_000, workOutput: 1_000 },
    ]);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });
    expect(estimate.basedOn).toBe('heuristic');
    expect(estimate.notes).toMatch(/different models/i);
  });

  it('keeps empirical when only the *removed* steps had a different model', async () => {
    // Past runs include cost-log rows for a step id that no longer
    // exists in the current shape (e.g. step was deleted). The current
    // fingerprint asks about s0 only — and that matches.
    mockWorkflow(makeDefinition(['llm_call']));
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([
      { id: 'e1', inputData: { modelIds: [] } },
      { id: 'e2', inputData: { modelIds: [] } },
      { id: 'e3', inputData: { modelIds: [] } },
    ] as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([
      // s0 on Sonnet (matches current shape).
      ...['e1', 'e2', 'e3'].map((id) => ({
        workflowExecutionId: id,
        inputTokens: 3_000,
        outputTokens: 1_000,
        metadata: { stepId: 's0' },
        model: CHAT_MODEL.id,
      })),
      // A retired step that used to exist, logged on a different model.
      ...['e1', 'e2', 'e3'].map((id) => ({
        workflowExecutionId: id,
        inputTokens: 100,
        outputTokens: 50,
        metadata: { stepId: 's_retired' },
        model: HAIKU.id,
      })),
    ] as never);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });
    expect(estimate.basedOn).toBe('empirical');
    expect(estimate.sampleSize).toBe(3);
  });

  it('calibrates work tokens from all past runs regardless of supervisor toggle', async () => {
    // Past runs all had the supervisor on — but the work-token bucket
    // is isolated from supervisor tokens by stepId, so it's valid
    // calibration data for a supervisor=false request too. The toggle
    // should change the supervisor add-on, not which methodology runs.
    mockWorkflow(makeDefinition(['llm_call', 'supervisor']));
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

    const withSup = await estimateWorkflowCost({ workflowId: 'wf-1', supervisor: true });
    const withoutSup = await estimateWorkflowCost({ workflowId: 'wf-1', supervisor: false });

    // Both should pick empirical — work calibration carries across the toggle.
    expect(withSup.basedOn).toBe('empirical');
    expect(withoutSup.basedOn).toBe('empirical');
    expect(withSup.sampleSize).toBe(3);
    expect(withoutSup.sampleSize).toBe(3);

    // The supervisor add-on must move the cost in the right direction
    // (adds the judge-model bill) and must not flip the methodology.
    expect(withSup.midUsd).toBeGreaterThan(withoutSup.midUsd);
    expect(withoutSup.judgeModelUsed).toBeNull();
    expect(withSup.judgeModelUsed).toBe(CHAT_MODEL.id);
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
  it('counts agent_call as 3 LLM steps (tool-iteration multiplier)', async () => {
    const def = makeDefinition(['agent_call']);
    const shape = await summariseShape(def, CHAT_MODEL.id);
    expect(shape.llmStepCount).toBe(3);
  });

  it('counts reflect as 2 LLM steps (draft + critique)', async () => {
    const def = makeDefinition(['reflect']);
    const shape = await summariseShape(def, CHAT_MODEL.id);
    expect(shape.llmStepCount).toBe(2);
  });

  it('excludes non-LLM step types from the count', async () => {
    const def = makeDefinition(['tool_call', 'external_call', 'send_notification', 'parallel']);
    const shape = await summariseShape(def, CHAT_MODEL.id);
    expect(shape.llmStepCount).toBe(0);
  });

  it('collects supervisor step ids separately', async () => {
    const def = makeDefinition(['llm_call', 'supervisor', 'supervisor']);
    const shape = await summariseShape(def, CHAT_MODEL.id);
    expect(shape.llmStepCount).toBe(1); // supervisors don't count toward LLM step count
    expect(shape.hasSupervisor).toBe(true);
    expect(shape.supervisorStepIds.size).toBe(2);
  });

  it('resolves each LLM step to its modelOverride when present', async () => {
    const def = makeDefinition(['llm_call', 'llm_call']);
    def.steps[1].config = { ...def.steps[1].config, modelOverride: 'gpt-5' };
    const shape = await summariseShape(def, CHAT_MODEL.id);
    expect(shape.workSteps).toHaveLength(2);
    expect(shape.workSteps[0].modelId).toBe(CHAT_MODEL.id);
    expect(shape.workSteps[1].modelId).toBe('gpt-5');
  });

  it('resolves agent_call steps to the agent bound model', async () => {
    const def = makeDefinition(['agent_call']);
    def.steps[0].config = { agentSlug: 'auditor' };
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      { slug: 'auditor', model: 'gpt-5' },
    ] as never);
    const shape = await summariseShape(def, CHAT_MODEL.id);
    expect(shape.workSteps).toHaveLength(1);
    expect(shape.workSteps[0].modelId).toBe('gpt-5');
  });

  it('falls back to chat default for agent_call when the agent has no bound model', async () => {
    const def = makeDefinition(['agent_call']);
    def.steps[0].config = { agentSlug: 'auditor' };
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      { slug: 'auditor', model: null },
    ] as never);
    const shape = await summariseShape(def, CHAT_MODEL.id);
    expect(shape.workSteps[0].modelId).toBe(CHAT_MODEL.id);
  });

  it('modelOverride on an agent_call beats the agent bound model', async () => {
    const def = makeDefinition(['agent_call']);
    def.steps[0].config = { agentSlug: 'auditor', modelOverride: 'gpt-5' };
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      { slug: 'auditor', model: 'claude-haiku-4-5' },
    ] as never);
    const shape = await summariseShape(def, CHAT_MODEL.id);
    expect(shape.workSteps[0].modelId).toBe('gpt-5');
  });

  it('captures supervisor modelOverride when present', async () => {
    const def = makeDefinition(['llm_call', 'supervisor']);
    def.steps[1].config = { ...def.steps[1].config, modelOverride: 'gpt-5' };
    const shape = await summariseShape(def, CHAT_MODEL.id);
    expect(shape.supervisorModelId).toBe('gpt-5');
  });
});

// ─── Per-model pricing ────────────────────────────────────────────────────

describe('estimateWorkflowCost — per-model pricing', () => {
  it('prices the modelOverride step at the override rate, not the chat default', async () => {
    // Two LLM steps: first runs on the chat default (Sonnet), second
    // overrides to Haiku. Per-step token allocation: 3_000 input +
    // 1_000 output each. Per-model cost:
    //   Sonnet: 3_000/1M × 3 + 1_000/1M × 15 = $0.009 + $0.015 = $0.024
    //   Haiku:  3_000/1M × 1 + 1_000/1M × 5  = $0.003 + $0.005 = $0.008
    //   Total ≈ $0.032
    const def = makeDefinition(['llm_call', 'llm_call']);
    def.steps[1].config = { ...def.steps[1].config, modelOverride: HAIKU.id };
    mockWorkflow(def);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });

    expect(estimate.modelMix).toHaveLength(2);
    const sonnetEntry = estimate.modelMix.find((m) => m.modelId === CHAT_MODEL.id);
    const haikuEntry = estimate.modelMix.find((m) => m.modelId === HAIKU.id);
    expect(sonnetEntry?.costUsd).toBeCloseTo(0.024, 4);
    expect(haikuEntry?.costUsd).toBeCloseTo(0.008, 4);
    expect(estimate.midUsd).toBeCloseTo(0.032, 4);
  });

  it('groups steps using the same model into a single modelMix entry', async () => {
    // Three steps, all running on Sonnet — one combined modelMix entry.
    const def = makeDefinition(['llm_call', 'llm_call', 'evaluate']);
    mockWorkflow(def);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });

    expect(estimate.modelMix).toHaveLength(1);
    expect(estimate.modelMix[0].modelId).toBe(CHAT_MODEL.id);
    expect(estimate.modelMix[0].role).toBe('work');
  });

  it('lists supervisor as a separate modelMix entry under its judge model', async () => {
    const def = makeDefinition(['llm_call', 'supervisor']);
    mockWorkflow(def);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1', supervisor: true });

    const supervisorEntry = estimate.modelMix.find((m) => m.role === 'supervisor');
    expect(supervisorEntry).toBeDefined();
    expect(supervisorEntry?.modelId).toBe(CHAT_MODEL.id); // JUDGE_MODEL null → chat default
  });

  it('marks pricingKnown=true for models the registry has, false for unknowns', async () => {
    const def = makeDefinition(['llm_call', 'llm_call']);
    def.steps[1].config = { ...def.steps[1].config, modelOverride: 'gpt-5' };
    mockWorkflow(def);
    // Only CHAT_MODEL is in the registry; gpt-5 returns undefined.

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });

    const sonnetEntry = estimate.modelMix.find((m) => m.modelId === CHAT_MODEL.id);
    const gpt5Entry = estimate.modelMix.find((m) => m.modelId === 'gpt-5');
    expect(sonnetEntry?.pricingKnown).toBe(true);
    expect(gpt5Entry?.pricingKnown).toBe(false);
    expect(gpt5Entry?.costUsd).toBe(0);
  });

  it('treats a registry entry with zero pricing as unpriced (matrix row with no cost)', async () => {
    // Operator added 'gpt-5' to the matrix but left costPerMillionTokens
    // NULL. After hydration the registry has a gpt-5 entry with $0 cost —
    // the conservative `registerModels` merge from earlier in this branch
    // keeps OR pricing on known models, but a model that's *only* in the
    // matrix (no OR / fallback entry) still surfaces with both costs at
    // zero. UI must call this out instead of reading $0 as "free".
    const ZERO_MODEL = {
      id: 'gpt-5',
      name: 'gpt-5',
      provider: 'openai',
      tier: 'mid' as const,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      maxContext: 0,
      supportsTools: true,
    };
    mockModelLookup({ [CHAT_MODEL.id]: CHAT_MODEL, [ZERO_MODEL.id]: ZERO_MODEL });

    const def = makeDefinition(['llm_call']);
    def.steps[0].config = { ...def.steps[0].config, modelOverride: 'gpt-5' };
    mockWorkflow(def);

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });

    const gpt5Entry = estimate.modelMix.find((m) => m.modelId === 'gpt-5');
    expect(gpt5Entry?.pricingKnown).toBe(false);
  });
});

// ─── Registry warmup ──────────────────────────────────────────────────────

describe('estimateWorkflowCost — registry warmup', () => {
  it('triggers refreshFromOpenRouter + hydrateFromDb before pricing', async () => {
    // Cold path: an operator hits the cost-estimate endpoint before any
    // other route warms the registry. Without the warmup, the in-memory
    // registry only has the static fallback and any operator-curated id
    // prices to $0. The warmup is heavily cached so the cost is paid
    // once per process.
    mockWorkflow(makeDefinition(['llm_call']));

    await estimateWorkflowCost({ workflowId: 'wf-1' });

    expect(vi.mocked(refreshFromOpenRouter)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hydrateModelRegistryFromDb)).toHaveBeenCalledTimes(1);
  });

  it('still produces an estimate when both warmup calls fail', async () => {
    // `allSettled` lets a transient OR outage or a DB hiccup happen
    // without breaking the dialog. The estimate falls back to whatever
    // the registry already had.
    vi.mocked(refreshFromOpenRouter).mockRejectedValueOnce(new Error('OR down'));
    vi.mocked(hydrateModelRegistryFromDb).mockRejectedValueOnce(new Error('DB blip'));
    mockWorkflow(makeDefinition(['llm_call']));

    const estimate = await estimateWorkflowCost({ workflowId: 'wf-1' });

    expect(estimate.midUsd).toBeGreaterThanOrEqual(0);
    expect(estimate.modelMix.length).toBeGreaterThan(0);
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
