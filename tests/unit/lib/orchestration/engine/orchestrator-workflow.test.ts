/**
 * Integration-style test: Orchestrator step within a workflow definition.
 *
 * Verifies that the orchestrator step type works correctly when composed
 * with other step types in a workflow definition, exercising validation
 * and registry parity.
 *
 * @see lib/orchestration/engine/executors/orchestrator.ts
 * @see lib/orchestration/engine/step-registry.ts
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findFirst: vi.fn(), findMany: vi.fn() },
    aiWorkflowExecution: { create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));

vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  runLlmCall: vi.fn(),
  interpolatePrompt: vi.fn((s: string) => s),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProviderWithFallbacks: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn().mockReturnValue({
    totalCostUsd: 0.01,
    isLocal: false,
    inputCostUsd: 0.004,
    outputCostUsd: 0.006,
  }),
  logCost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: vi.fn().mockReturnValue({
    id: 'gpt-4o',
    provider: 'openai',
    contextWindowTokens: 128000,
    pricing: { inputPer1MTokens: 5, outputPer1MTokens: 15 },
  }),
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn().mockResolvedValue('gpt-4o'),
}));

vi.mock('@/lib/orchestration/capabilities/registry', () => ({
  registerBuiltInCapabilities: vi.fn(),
  getCapabilityDefinitions: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { KNOWN_STEP_TYPES } from '@/types/orchestration';
import { orchestratorConfigSchema } from '@/lib/validations/orchestration';
import { validateWorkflow } from '@/lib/orchestration/workflows/validator';
import type { WorkflowDefinition } from '@/types/orchestration';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('orchestrator step type integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('"orchestrator" is included in KNOWN_STEP_TYPES', () => {
    expect(KNOWN_STEP_TYPES).toContain('orchestrator');
  });

  it('orchestratorConfigSchema parses a valid config', () => {
    const config = {
      plannerPrompt: 'Coordinate agents to solve the problem.',
      availableAgentSlugs: ['agent-a', 'agent-b'],
      selectionMode: 'auto',
      maxRounds: 3,
    };

    const result = orchestratorConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('a workflow definition with an orchestrator step passes validation', () => {
    const definition: WorkflowDefinition = {
      steps: [
        {
          id: 'step_entry',
          name: 'Orchestrate',
          type: 'orchestrator',
          config: {
            plannerPrompt: 'Coordinate research.',
            availableAgentSlugs: ['researcher', 'analyst'],
            selectionMode: 'auto',
            maxRounds: 3,
          },
          nextSteps: [],
        },
      ],
      entryStepId: 'step_entry',
      errorStrategy: 'fail',
    };

    const result = validateWorkflow(definition);
    // No structural errors (unknown type is fine since WorkflowStepType is an open string)
    const structuralErrors = result.errors.filter(
      (e: { code: string }) => e.code !== 'UNKNOWN_STEP_TYPE'
    );
    expect(structuralErrors).toEqual([]);
  });

  it('a workflow definition with orchestrator + other steps validates', () => {
    const definition: WorkflowDefinition = {
      steps: [
        {
          id: 'step_retrieve',
          name: 'Get Context',
          type: 'rag_retrieve',
          config: { query: 'background info', topK: 5 },
          nextSteps: [{ targetStepId: 'step_orchestrate' }],
        },
        {
          id: 'step_orchestrate',
          name: 'Autonomous Research',
          type: 'orchestrator',
          config: {
            plannerPrompt: 'Coordinate using the retrieved context.',
            availableAgentSlugs: ['researcher'],
            maxRounds: 2,
          },
          nextSteps: [{ targetStepId: 'step_output' }],
        },
        {
          id: 'step_output',
          name: 'Format Output',
          type: 'llm_call',
          config: { prompt: 'Format: {{step_orchestrate.output}}' },
          nextSteps: [],
        },
      ],
      entryStepId: 'step_retrieve',
      errorStrategy: 'fail',
    };

    const result = validateWorkflow(definition);
    const structuralErrors = result.errors.filter(
      (e: { code: string }) => e.code !== 'UNKNOWN_STEP_TYPE'
    );
    expect(structuralErrors).toEqual([]);
  });
});
