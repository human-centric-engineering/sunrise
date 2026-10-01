import { describe, it, expect, beforeEach, vi } from 'vitest';

// The org's provider policy (§120 t-743): approves everything unless a test
// refuses a slug.
// The policy applies (an org at multi) unless a test says otherwise.
const mockPolicyScope = vi.hoisted(() => vi.fn((): 'open' | 'no-org' | 'enforced' => 'enforced'));
const mockUnapprovedProviders = vi.hoisted(() =>
  vi.fn(async (_slugs: readonly string[]): Promise<string[]> => [])
);
const mockHydrate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/orchestration/llm/model-registry-db-hydrate', () => ({
  hydrateFromDb: mockHydrate,
}));
vi.mock('@/lib/orchestration/llm/org-provider-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/org-provider-policy')>()),
  unapprovedProviders: mockUnapprovedProviders,
  orgProviderPolicyScope: mockPolicyScope,
}));

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

vi.mock('@/lib/orchestration/llm', () => ({
  modelRegistry: {
    getModel: vi.fn(),
  },
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

import {
  assertWorkflowProvidersApproved,
  findUnapprovedModelOverrides,
  findUnapprovedModelOverridesIn,
  semanticValidateWorkflow,
} from '@/lib/orchestration/workflows/semantic-validator';
import { prisma } from '@/lib/db/client';
import { modelRegistry } from '@/lib/orchestration/llm';

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
    vi.mocked(modelRegistry.getModel).mockReturnValue(undefined);
  });

  it('returns ok when no LLM steps have modelOverride and no tool_call steps', async () => {
    const result = await semanticValidateWorkflow(makeDef([llmStep('s1')]));
    // test-review:accept tobe_true — boolean field `ok` on SemanticValidationResult; structural assertion on validation outcome
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
    vi.mocked(modelRegistry.getModel).mockReturnValue({
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
    vi.mocked(modelRegistry.getModel).mockReturnValue({
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
    // test-review:accept tobe_true — boolean field `ok` on SemanticValidationResult; structural assertion on validation outcome
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
    // test-review:accept tobe_true — boolean field `ok` on SemanticValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('skips steps without modelOverride or capabilitySlug', async () => {
    const def = makeDef([
      llmStep('s1'), // no modelOverride
      { id: 's2', name: 's2', type: 'human_approval', config: { prompt: 'ok?' }, nextSteps: [] },
    ]);
    const result = await semanticValidateWorkflow(def);
    // test-review:accept tobe_true — boolean field `ok` on SemanticValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
    // test-review:accept clear_then_notcalled — clearAllMocks is in beforeEach (not mid-test); not.toHaveBeenCalled verifies fast-path skips DB
    // No DB calls should have been made (fast path)
    expect(prisma.aiProviderConfig.findMany).not.toHaveBeenCalled();
    expect(prisma.aiCapability.findMany).not.toHaveBeenCalled();
  });

  it('batches — multiple steps with same model produce one getModel call', async () => {
    vi.mocked(modelRegistry.getModel).mockReturnValue({
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
    // test-review:accept tobe_true — boolean field `ok` on SemanticValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
    // getModel called once per unique model id, not per step
    expect(modelRegistry.getModel).toHaveBeenCalledTimes(1);
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

    // test-review:accept tobe_true — boolean field `ok` on SemanticValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('resolves a platform slug the way agent_call will: system rows only (§116 t-725)', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);

    await semanticValidateWorkflow(
      makeDef([agentStep('s1', 'eval-case-generator'), agentStep('s2', 'my-agent')])
    );

    expect(prisma.aiAgent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          NOT: { slug: { in: ['eval-case-generator'] }, isSystem: false },
        }),
      })
    );
  });

  it('batches multiple agent_call steps with the same slug into one DB query', async () => {
    // Arrange — two steps reference the same agent; DB query should fire only once.
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([{ slug: 'shared-agent' }] as never);

    const def = makeDef([agentStep('s1', 'shared-agent'), agentStep('s2', 'shared-agent')]);
    const result = await semanticValidateWorkflow(def);

    // test-review:accept tobe_true — boolean field `ok` on SemanticValidationResult; structural assertion on validation outcome
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
    // test-review:accept tobe_true — boolean field `ok` on SemanticValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(prisma.aiProviderConfig.findMany).not.toHaveBeenCalled();
    expect(prisma.aiCapability.findMany).not.toHaveBeenCalled();
    expect(prisma.aiAgent.findMany).not.toHaveBeenCalled();
  });
});

describe('org approval of a modelOverride provider (§120 t-743)', () => {
  const sonnet = {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    name: 'Claude Sonnet',
    maxContext: 200000,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    tier: 'frontier',
    supportsTools: true,
    available: true,
  } as const;
  const gpt = { ...sonnet, id: 'gpt-5', provider: 'openai' };
  const refuseAnthropic = async (slugs: readonly string[]) =>
    slugs.filter((slug) => slug === 'anthropic');

  beforeEach(() => {
    vi.clearAllMocks();
    mockPolicyScope.mockReturnValue('enforced');
    mockUnapprovedProviders.mockImplementation(async () => []);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      { slug: 'anthropic' },
      { slug: 'openai' },
    ] as never);
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
    vi.mocked(modelRegistry.getModel).mockImplementation(
      (id: string) => ({ 'claude-sonnet-4-6': sonnet, 'gpt-5': gpt })[id]
    );
  });

  it('returns PROVIDER_NOT_APPROVED for each step overriding to a non-approved provider', async () => {
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);

    const result = await semanticValidateWorkflow(
      makeDef([llmStep('s1', 'claude-sonnet-4-6'), llmStep('s2', 'claude-sonnet-4-6')]),
      { approval: {} }
    );

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => [e.code, e.stepId])).toEqual([
      ['PROVIDER_NOT_APPROVED', 's1'],
      ['PROVIDER_NOT_APPROVED', 's2'],
    ]);
  });

  it("checks a supervisor step's override, which chooses its provider too", async () => {
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);
    const supervisor = { ...llmStep('sup', 'claude-sonnet-4-6'), type: 'supervisor' };

    const result = await semanticValidateWorkflow(makeDef([supervisor]), { approval: {} });

    expect(result.errors.map((e) => e.code)).toEqual(['PROVIDER_NOT_APPROVED']);
  });

  it('does not refuse a provider the replaced version already used', async () => {
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);
    const held = vi.fn(async () => makeDef([llmStep('old', 'claude-sonnet-4-6')]));

    const result = await semanticValidateWorkflow(
      makeDef([llmStep('s1', 'claude-sonnet-4-6'), llmStep('s2', 'gpt-5')]),
      { approval: { held } }
    );

    expect(result.errors).toEqual([]);
    expect(held).toHaveBeenCalledTimes(1);
  });

  it('still refuses a provider the replaced version did not use', async () => {
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);
    const held = vi.fn(async () => makeDef([llmStep('old', 'gpt-5')]));

    const result = await semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]), {
      approval: { held },
    });

    expect(result.errors.map((e) => e.code)).toEqual(['PROVIDER_NOT_APPROVED']);
  });

  it('never loads the replaced version when nothing is refused (always, at single)', async () => {
    const held = vi.fn(async () => null);

    await semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]), {
      approval: { held },
    });

    expect(held).not.toHaveBeenCalled();
  });

  it('does not subject supervisor steps to the existence checks — execution is unchanged', async () => {
    vi.mocked(modelRegistry.getModel).mockReturnValue(undefined);
    const supervisor = { ...llmStep('sup', 'unknown-model'), type: 'supervisor' };

    const result = await semanticValidateWorkflow(makeDef([supervisor]));

    expect(result.errors).toEqual([]);
  });

  it('skips the check, logged, for a diagnostic that asked to skip an unreadable policy', async () => {
    mockUnapprovedProviders.mockRejectedValue(new Error('connection reset'));

    const result = await semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]), {
      approval: { onUnreadable: 'skip' },
    });

    expect(result.errors).toEqual([]);
  });

  it('asks the policy once for a whole batch of definitions', async () => {
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);

    const found = await findUnapprovedModelOverridesIn(
      new Map([
        ['a', makeDef([llmStep('s1', 'claude-sonnet-4-6')])],
        ['b', makeDef([llmStep('s1', 'gpt-5')])],
      ])
    );

    expect(mockUnapprovedProviders).toHaveBeenCalledTimes(1);
    expect(mockHydrate).toHaveBeenCalledTimes(1);
    expect([...found].map(([key, errors]) => [key, errors.length])).toEqual([
      ['a', 1],
      ['b', 0],
    ]);
  });

  it('does nothing where the policy is open — not even hydrate (single, the install org)', async () => {
    mockPolicyScope.mockReturnValue('open');
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);

    const result = await semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]), {
      approval: {},
    });

    expect(result.errors).toEqual([]);
    expect(mockHydrate).not.toHaveBeenCalled();
    expect(mockUnapprovedProviders).not.toHaveBeenCalled();
  });

  it('reports a step on an inactive provider once, not also as unapproved', async () => {
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([{ slug: 'openai' }] as never);

    const result = await semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]), {
      approval: {},
    });

    expect(result.errors.map((e) => e.code)).toEqual(['INACTIVE_PROVIDER']);
  });

  it('refuses, on create, a model whose provider cannot be determined where the policy applies', async () => {
    await expect(
      assertWorkflowProvidersApproved(makeDef([llmStep('s1', 'not-in-registry')]))
    ).rejects.toMatchObject({
      status: 400,
      details: { definition: [expect.stringContaining('its provider cannot be checked')] },
    });
  });

  it('lets an unknown model through on create where the policy is open', async () => {
    mockPolicyScope.mockReturnValue('open');
    await expect(
      assertWorkflowProvidersApproved(makeDef([llmStep('s1', 'not-in-registry')]))
    ).resolves.toBeUndefined();
  });

  it('says no organisation is in scope, rather than blaming one, when none is', async () => {
    mockPolicyScope.mockReturnValue('no-org');
    mockUnapprovedProviders.mockImplementation(async (slugs) => [...slugs]);

    await expect(
      assertWorkflowProvidersApproved(makeDef([llmStep('s1', 'claude-sonnet-4-6')]))
    ).rejects.toMatchObject({
      message:
        'No organisation is in scope for this request, so no provider can be approved for it',
    });
  });

  it('refuses a definition with a 400 naming the steps, for create and save-as-template', async () => {
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);

    await expect(
      assertWorkflowProvidersApproved(makeDef([llmStep('s1', 'claude-sonnet-4-6')]))
    ).rejects.toMatchObject({
      status: 400,
      message: 'Workflow steps use providers this organisation is not approved for',
      details: { definition: [expect.stringContaining('Step "s1"')] },
    });
  });

  it('is not asked without the approval option — execution leaves a refused step to the gate', async () => {
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);

    const result = await semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]));

    expect(result.errors).toEqual([]);
    expect(mockUnapprovedProviders).not.toHaveBeenCalled();
  });

  it('throws when the policy cannot be read, rather than passing the save unchecked', async () => {
    mockUnapprovedProviders.mockRejectedValue(new Error('connection reset'));

    await expect(
      semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]), { approval: {} })
    ).rejects.toThrow('connection reset');
  });

  it('keeps its findings when the existence queries fail and are skipped', async () => {
    mockUnapprovedProviders.mockImplementation(refuseAnthropic);
    vi.mocked(prisma.aiProviderConfig.findMany).mockRejectedValue(new Error('db down'));

    const result = await semanticValidateWorkflow(makeDef([llmStep('s1', 'claude-sonnet-4-6')]), {
      approval: {},
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(['PROVIDER_NOT_APPROVED']);
  });

  it('hydrates the registry from the Model Matrix before looking models up', async () => {
    await findUnapprovedModelOverrides(makeDef([llmStep('s1', 'claude-sonnet-4-6')]));
    expect(mockHydrate).toHaveBeenCalled();
  });

  it('leaves an unknown model to UNKNOWN_MODEL_OVERRIDE rather than asking about it', async () => {
    vi.mocked(modelRegistry.getModel).mockReturnValue(undefined);

    expect(await findUnapprovedModelOverrides(makeDef([llmStep('s1', 'nope')]))).toEqual([]);
    expect(mockUnapprovedProviders).toHaveBeenCalledWith([]);
  });
});
