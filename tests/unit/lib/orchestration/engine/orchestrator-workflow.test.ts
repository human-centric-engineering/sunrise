/**
 * Workflow Validator Tests
 *
 * Structural validation of WorkflowDefinition via validateWorkflow().
 * Tests cover every error code the validator can emit plus happy-path
 * workflows including the orchestrator step type.
 *
 * Test Coverage:
 * - MISSING_ENTRY — entryStepId not in steps
 * - DUPLICATE_STEP_ID — two steps with the same id
 * - UNKNOWN_TARGET — nextSteps references a missing step id
 * - UNREACHABLE_STEP — step not reachable from entry
 * - CYCLE_DETECTED — back-edge in the DAG
 * - MISSING_APPROVAL_PROMPT — human_approval without config.prompt
 * - MISSING_CAPABILITY_SLUG — tool_call without config.capabilitySlug
 * - MISSING_GUARD_RULES — guard without config.rules
 * - MISSING_EVALUATE_RUBRIC — evaluate without config.rubric
 * - MISSING_EXTERNAL_URL — external_call without config.url
 * - MISSING_AGENT_SLUG — agent_call without config.agentSlug
 * - Happy path: valid single-step and multi-step workflows
 * - orchestratorConfigSchema parses a valid config
 *
 * @see lib/orchestration/workflows/validator.ts
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

import { orchestratorConfigSchema } from '@/lib/validations/orchestration';
import { validateWorkflow } from '@/lib/orchestration/workflows/validator';
import type { WorkflowDefinition } from '@/types/orchestration';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid single-step workflow. */
function singleStep(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    steps: [
      {
        id: 'step_entry',
        name: 'Entry',
        type: 'llm_call',
        config: { prompt: 'Hello' },
        nextSteps: [],
      },
    ],
    entryStepId: 'step_entry',
    errorStrategy: 'fail',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('should return ok:true for a valid single-step workflow', () => {
      // Arrange
      const definition = singleStep();

      // Act
      const result = validateWorkflow(definition);

      // Assert
      // test-review:accept tobe_true — structural assertion on validator ok boolean field
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should return ok:true for a valid multi-step workflow with orchestrator step', () => {
      // Arrange
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

      // Act
      const result = validateWorkflow(definition);

      // Assert
      // test-review:accept tobe_true — structural assertion on validator ok boolean field
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  // ── Structural errors ─────────────────────────────────────────────────────

  describe('structural errors', () => {
    it('should emit MISSING_ENTRY when entryStepId does not exist in steps', () => {
      // Arrange
      const definition = singleStep({ entryStepId: 'nonexistent' });

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'MISSING_ENTRY')).toBe(true);
    });

    it('should emit DUPLICATE_STEP_ID when two steps share the same id', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_a',
            name: 'Step A (first)',
            type: 'llm_call',
            config: { prompt: 'First' },
            nextSteps: [],
          },
          {
            id: 'step_a',
            name: 'Step A (duplicate)',
            type: 'llm_call',
            config: { prompt: 'Second' },
            nextSteps: [],
          },
        ],
        entryStepId: 'step_a',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'DUPLICATE_STEP_ID');
      expect(error).toBeDefined();
      expect(error?.stepId).toBe('step_a');
    });

    it('should emit UNKNOWN_TARGET when a nextSteps edge points to a missing step id', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'Entry',
            type: 'llm_call',
            config: { prompt: 'Go' },
            nextSteps: [{ targetStepId: 'step_ghost' }],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'UNKNOWN_TARGET');
      expect(error).toBeDefined();
      expect(error?.stepId).toBe('step_entry');
    });

    it('should emit UNREACHABLE_STEP for a step not reachable from entry', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'Entry',
            type: 'llm_call',
            config: { prompt: 'Hello' },
            nextSteps: [],
          },
          {
            id: 'step_orphan',
            name: 'Orphan',
            type: 'llm_call',
            config: { prompt: 'Unreachable' },
            nextSteps: [],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'UNREACHABLE_STEP');
      expect(error).toBeDefined();
      expect(error?.stepId).toBe('step_orphan');
    });

    it('should emit CYCLE_DETECTED when steps form a cycle', () => {
      // Arrange — A → B → A
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_a',
            name: 'Step A',
            type: 'llm_call',
            config: { prompt: 'A' },
            nextSteps: [{ targetStepId: 'step_b' }],
          },
          {
            id: 'step_b',
            name: 'Step B',
            type: 'llm_call',
            config: { prompt: 'B' },
            nextSteps: [{ targetStepId: 'step_a' }],
          },
        ],
        entryStepId: 'step_a',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'CYCLE_DETECTED');
      expect(error).toBeDefined();
      expect(Array.isArray(error?.path)).toBe(true);
    });
  });

  // ── Step-type config errors ───────────────────────────────────────────────

  describe('step-type config errors', () => {
    it('should emit MISSING_APPROVAL_PROMPT for a human_approval step without config.prompt', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'Approval',
            type: 'human_approval',
            config: {},
            nextSteps: [],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'MISSING_APPROVAL_PROMPT');
      expect(error).toBeDefined();
      expect(error?.stepId).toBe('step_entry');
    });

    it('should emit MISSING_APPROVAL_PROMPT when human_approval config.prompt is blank', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'Approval',
            type: 'human_approval',
            config: { prompt: '   ' },
            nextSteps: [],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'MISSING_APPROVAL_PROMPT')).toBe(true);
    });

    it('should emit MISSING_CAPABILITY_SLUG for a tool_call step without config.capabilitySlug', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'Tool',
            type: 'tool_call',
            config: {},
            nextSteps: [],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'MISSING_CAPABILITY_SLUG');
      expect(error).toBeDefined();
      expect(error?.stepId).toBe('step_entry');
    });

    it('should emit MISSING_GUARD_RULES for a guard step without config.rules', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'Guard',
            type: 'guard',
            config: {},
            nextSteps: [],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'MISSING_GUARD_RULES');
      expect(error).toBeDefined();
      expect(error?.stepId).toBe('step_entry');
    });

    it('should emit MISSING_EVALUATE_RUBRIC for an evaluate step without config.rubric', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'Evaluate',
            type: 'evaluate',
            config: {},
            nextSteps: [],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'MISSING_EVALUATE_RUBRIC');
      expect(error).toBeDefined();
      expect(error?.stepId).toBe('step_entry');
    });

    it('should emit MISSING_EXTERNAL_URL for an external_call step without config.url', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'External',
            type: 'external_call',
            config: {},
            nextSteps: [],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'MISSING_EXTERNAL_URL');
      expect(error).toBeDefined();
      expect(error?.stepId).toBe('step_entry');
    });

    it('should emit MISSING_AGENT_SLUG for an agent_call step without config.agentSlug', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'Agent Call',
            type: 'agent_call',
            config: {},
            nextSteps: [],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.code === 'MISSING_AGENT_SLUG');
      expect(error).toBeDefined();
      expect(error?.stepId).toBe('step_entry');
    });

    it('should not emit MISSING_APPROVAL_PROMPT when human_approval has a non-empty prompt', () => {
      // Arrange
      const definition: WorkflowDefinition = {
        steps: [
          {
            id: 'step_entry',
            name: 'Approval',
            type: 'human_approval',
            config: { prompt: 'Please review and approve' },
            nextSteps: [],
          },
        ],
        entryStepId: 'step_entry',
        errorStrategy: 'fail',
      };

      // Act
      const result = validateWorkflow(definition);

      // Assert
      // test-review:accept tobe_true — structural assertion on validator ok boolean field
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  // ── orchestratorConfigSchema ──────────────────────────────────────────────

  describe('orchestratorConfigSchema', () => {
    it('should parse a valid orchestrator config', () => {
      // Arrange
      const config = {
        plannerPrompt: 'Coordinate agents to solve the problem.',
        availableAgentSlugs: ['agent-a', 'agent-b'],
        selectionMode: 'auto',
        maxRounds: 3,
      };

      // Act
      const result = orchestratorConfigSchema.safeParse(config);

      // test-review:accept tobe_true — structural assertion on Zod schema parse success field
      expect(result.success).toBe(true);
    });
  });
});
