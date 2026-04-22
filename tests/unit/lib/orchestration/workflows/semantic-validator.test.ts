import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { WorkflowDefinition } from '@/types/orchestration';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: { findMany: vi.fn() },
    aiCapability: { findMany: vi.fn() },
    aiAgent: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: vi.fn(),
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

import { semanticValidateWorkflow } from '@/lib/orchestration/workflows/semantic-validator';
import { prisma } from '@/lib/db/client';
import { getModel } from '@/lib/orchestration/llm/model-registry';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDef(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return {
    steps,
    entryStepId: steps[0]?.id ?? 'step-1',
    errorStrategy: 'fail',
  };
}

function llmStep(id: string, modelOverride?: string) {
  return {
    id,
    name: id,
    type: 'llm_call',
    config: modelOverride ? { modelOverride } : {},
    nextSteps: [],
  };
}

function toolStep(id: string, capabilitySlug: string) {
  return {
    id,
    name: id,
    type: 'tool_call',
    config: { capabilitySlug },
    nextSteps: [],
  };
}

function agentStep(id: string, agentSlug: string) {
  return {
    id,
    name: id,
    type: 'agent_call',
    config: { agentSlug },
    nextSteps: [],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('semanticValidateWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
    vi.mocked(getModel).mockReturnValue(undefined);
  });

  it('returns ok when no LLM steps have modelOverride and no tool_call steps', async () => {
    const result = await semanticValidateWorkflow(makeDef([llmStep('s1')]));
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns UNKNOWN_MODEL_OVERRIDE when model is not in registry', async () => {
    const result = await semanticValidateWorkflow(makeDef([llmStep('s1', 'nonexistent-model')]));
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('UNKNOWN_MODEL_OVERRIDE');
    expect(result.errors[0].stepId).toBe('s1');
  });

  it('returns INACTIVE_PROVIDER when model exists but provider is not active', async () => {
    vi.mocked(getModel).mockReturnValue({
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      name: 'Claude Sonnet',
      maxContext: 200000,
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      tier: 'frontier',
      supportsTools: true,
      available: true,
    });
    // No active providers returned
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);

    const result = await semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]));
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('INACTIVE_PROVIDER');
    expect(result.errors[0].stepId).toBe('s1');
  });

  it('returns no error when model exists and provider is active', async () => {
    vi.mocked(getModel).mockReturnValue({
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      name: 'Claude Sonnet',
      maxContext: 200000,
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      tier: 'frontier',
      supportsTools: true,
      available: true,
    });
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([{ slug: 'anthropic' }] as never);

    const result = await semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]));
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns INACTIVE_CAPABILITY when capability slug is not found or inactive', async () => {
    const result = await semanticValidateWorkflow(makeDef([toolStep('s1', 'missing-cap')]));
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('INACTIVE_CAPABILITY');
    expect(result.errors[0].stepId).toBe('s1');
  });

  it('returns no error when capability is active', async () => {
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([{ slug: 'web-search' }] as never);

    const result = await semanticValidateWorkflow(makeDef([toolStep('s1', 'web-search')]));
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('skips steps without modelOverride or capabilitySlug', async () => {
    const def = makeDef([
      llmStep('s1'), // no modelOverride
      { id: 's2', name: 's2', type: 'human_approval', config: { prompt: 'ok?' }, nextSteps: [] },
    ]);
    const result = await semanticValidateWorkflow(def);
    expect(result.ok).toBe(true);
    // No DB calls should have been made (fast path)
    expect(prisma.aiProviderConfig.findMany).not.toHaveBeenCalled();
    expect(prisma.aiCapability.findMany).not.toHaveBeenCalled();
  });

  it('batches — multiple steps with same model produce one getModel call', async () => {
    vi.mocked(getModel).mockReturnValue({
      id: 'gpt-4o',
      provider: 'openai',
      name: 'GPT-4o',
      maxContext: 128000,
      inputCostPerMillion: 5,
      outputCostPerMillion: 15,
      tier: 'frontier',
      supportsTools: true,
      available: true,
    });
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([{ slug: 'openai' }] as never);

    const def = makeDef([
      llmStep('s1', 'gpt-4o'),
      llmStep('s2', 'gpt-4o'),
      llmStep('s3', 'gpt-4o'),
    ]);
    const result = await semanticValidateWorkflow(def);
    expect(result.ok).toBe(true);
    // getModel called once per unique model id, not per step
    expect(getModel).toHaveBeenCalledTimes(1);
  });

  it('checks all LLM step types: route, reflect, guard, evaluate', async () => {
    const steps = ['route', 'reflect', 'guard', 'evaluate'].map((type, i) => ({
      id: `s${i}`,
      name: `s${i}`,
      type,
      config: { modelOverride: 'unknown-model' },
      nextSteps: [],
    }));
    const result = await semanticValidateWorkflow(makeDef(steps));
    expect(result.ok).toBe(false);
    // All 4 steps should report UNKNOWN_MODEL_OVERRIDE
    expect(result.errors).toHaveLength(4);
    expect(result.errors.every((e) => e.code === 'UNKNOWN_MODEL_OVERRIDE')).toBe(true);
  });

  // ─── agent_call steps ───────────────────────────────────────────────────────

  it('returns INACTIVE_AGENT when agent slug is not found or inactive', async () => {
    // Arrange — aiAgent.findMany returns an empty list (agent not active).
    // aiAgent mock is already set to return [] in beforeEach.
    const result = await semanticValidateWorkflow(makeDef([agentStep('s1', 'missing-agent')]));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('INACTIVE_AGENT');
    expect(result.errors[0].stepId).toBe('s1');
  });

  it('returns no error when agent slug is active', async () => {
    // Arrange — aiAgent.findMany returns the slug we reference.
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([{ slug: 'my-agent' }] as never);

    const result = await semanticValidateWorkflow(makeDef([agentStep('s1', 'my-agent')]));

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('batches multiple agent_call steps with the same slug into one DB query', async () => {
    // Arrange — two steps reference the same agent; DB query should fire only once.
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([{ slug: 'shared-agent' }] as never);

    const def = makeDef([agentStep('s1', 'shared-agent'), agentStep('s2', 'shared-agent')]);
    const result = await semanticValidateWorkflow(def);

    expect(result.ok).toBe(true);
    // The validator batches by unique slug — only one DB call regardless of step count.
    expect(prisma.aiAgent.findMany).toHaveBeenCalledTimes(1);
  });

  it('fast-path returns ok immediately when no step has any reference to check', async () => {
    // Arrange — workflow with zero steps (degenerate but valid edge case).
    const def: WorkflowDefinition = {
      steps: [],
      entryStepId: 'nonexistent',
      errorStrategy: 'fail',
    };

    const result = await semanticValidateWorkflow(def);

    // Fast path — no DB queries fired.
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(prisma.aiProviderConfig.findMany).not.toHaveBeenCalled();
    expect(prisma.aiCapability.findMany).not.toHaveBeenCalled();
    expect(prisma.aiAgent.findMany).not.toHaveBeenCalled();
  });
});
