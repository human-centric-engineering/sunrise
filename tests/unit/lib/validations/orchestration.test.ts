/**
 * Agent Orchestration Validation Schema Tests
 *
 * Tests for every exported Zod schema in lib/validations/orchestration.ts:
 * - createAgentSchema
 * - updateAgentSchema
 * - createCapabilitySchema
 * - updateCapabilitySchema
 * - createWorkflowSchema
 * - updateWorkflowSchema
 * - chatMessageSchema
 * - workflowExecutionSchema
 * - evaluationSessionSchema
 * - knowledgeSearchSchema
 * - documentUploadSchema
 * - costQuerySchema
 * - providerConfigSchema
 * - chatAttachmentSchema
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createAgentSchema,
  updateAgentSchema,
  createCapabilitySchema,
  updateCapabilitySchema,
  createWorkflowSchema,
  updateWorkflowSchema,
  chatMessageSchema,
  workflowExecutionSchema,
  evaluationSessionSchema,
  knowledgeSearchSchema,
  documentUploadSchema,
  costQuerySchema,
  providerConfigSchema,
  listAgentsQuerySchema,
  listCapabilitiesQuerySchema,
  systemInstructionsHistoryEntrySchema,
  systemInstructionsHistorySchema,
  instructionsRevertSchema,
  widgetConfigSchema,
  updateWidgetConfigSchema,
  resolveWidgetConfig,
  DEFAULT_WIDGET_CONFIG,
  attachAgentCapabilitySchema,
  updateAgentCapabilitySchema,
  exportAgentsSchema,
  agentBundleSchema,
  importAgentsSchema,
  updateProviderConfigSchema,
  listProvidersQuerySchema,
  listWorkflowsQuerySchema,
  listExecutionsQuerySchema,
  executeWorkflowBodySchema,
  approveExecutionBodySchema,
  chatStreamRequestSchema,
  listConversationsQuerySchema,
  clearConversationsBodySchema,
  listDocumentsQuerySchema,
  getPatternParamSchema,
  costBreakdownQuerySchema,
  listEvaluationsQuerySchema,
  createEvaluationSchema,
  updateEvaluationSchema,
  evaluationLogsQuerySchema,
  completeEvaluationBodySchema,
  workflowDefinitionSchema,
  publishWorkflowSchema,
  rollbackWorkflowSchema,
  executionStatusSchema,
  executionTraceEntrySchema,
  executionTraceSchema,
  turnEntrySchema,
  turnEntriesSchema,
  chatAttachmentSchema,
  searchConfigSchema,
  createProviderModelSchema,
  updateProviderModelSchema,
  bulkCreateProviderModelsSchema,
  listProviderModelsQuerySchema,
} from '@/lib/validations/orchestration';

beforeEach(() => {
  vi.resetAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** A valid CUID: starts with 'c' + 24 lowercase alphanumeric chars (total 25) */
const VALID_CUID = 'cmjbv4i3x00003wsloputgwul';

/** A valid SHA-256 hex string (64 lowercase hex chars) */
const VALID_SHA256 = 'a'.repeat(64);

/** A valid slug: lowercase, alphanumeric, hyphens only */
const VALID_SLUG = 'my-agent-slug';

/** Minimal valid workflowDefinition object */
const VALID_WORKFLOW_DEF = {
  steps: [
    {
      id: 'step-1',
      name: 'Step One',
      type: 'llm_call',
      config: { agentId: VALID_CUID },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail' as const,
};

// ────────────────────────────────────────────────────────────────────────────
// createAgentSchema
// ────────────────────────────────────────────────────────────────────────────

describe('createAgentSchema', () => {
  const VALID_AGENT = {
    name: 'Test Agent',
    slug: VALID_SLUG,
    description: 'A test agent description.',
    systemInstructions: 'You are a helpful assistant.',
    model: 'claude-3-5-sonnet-20241022',
  };

  it('should accept a fully valid agent with all required fields', () => {
    const result = createAgentSchema.safeParse(VALID_AGENT);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should apply defaults: provider=anthropic, temperature=0.7, maxTokens=4096, isActive=true', () => {
    const result = createAgentSchema.safeParse(VALID_AGENT);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('anthropic');
      expect(result.data.temperature).toBe(0.7);
      expect(result.data.maxTokens).toBe(4096);
      // test-review:accept tobe_true — boolean schema field `isActive`; asserting parsed default value
      expect(result.data.isActive).toBe(true);
    }
  });

  it('should reject when name is missing', () => {
    const { name: _name, ...rest } = VALID_AGENT;
    const result = createAgentSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('should reject temperature below 0', () => {
    const result = createAgentSchema.safeParse({ ...VALID_AGENT, temperature: -0.1 });
    expect(result.success).toBe(false);
  });

  it('should reject temperature above 2', () => {
    const result = createAgentSchema.safeParse({ ...VALID_AGENT, temperature: 2.1 });
    expect(result.success).toBe(false);
  });

  it('should reject maxTokens above 200000', () => {
    const result = createAgentSchema.safeParse({ ...VALID_AGENT, maxTokens: 200001 });
    expect(result.success).toBe(false);
  });

  it('should reject monthlyBudgetUsd above 10000', () => {
    const result = createAgentSchema.safeParse({ ...VALID_AGENT, monthlyBudgetUsd: 10001 });
    expect(result.success).toBe(false);
  });

  it('should reject an invalid slug (uppercase)', () => {
    const result = createAgentSchema.safeParse({ ...VALID_AGENT, slug: 'Invalid-Slug' });
    expect(result.success).toBe(false);
  });

  it('should reject name longer than 100 characters', () => {
    const result = createAgentSchema.safeParse({ ...VALID_AGENT, name: 'a'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('should reject systemInstructions longer than 50000 characters', () => {
    const result = createAgentSchema.safeParse({
      ...VALID_AGENT,
      systemInstructions: 'x'.repeat(50001),
    });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// updateAgentSchema
// ────────────────────────────────────────────────────────────────────────────

describe('updateAgentSchema', () => {
  it('should accept an empty object (all fields optional)', () => {
    const result = updateAgentSchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should accept a partial update with only name', () => {
    const result = updateAgentSchema.safeParse({ name: 'New Name' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should accept monthlyBudgetUsd: null to clear the budget', () => {
    const result = updateAgentSchema.safeParse({ monthlyBudgetUsd: null });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.monthlyBudgetUsd).toBeNull();
    }
  });

  it('should reject empty string for name', () => {
    const result = updateAgentSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('should reject temperature out of range', () => {
    const result = updateAgentSchema.safeParse({ temperature: 3 });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// createCapabilitySchema
// ────────────────────────────────────────────────────────────────────────────

describe('createCapabilitySchema', () => {
  const VALID_CAPABILITY = {
    name: 'Web Search',
    slug: 'web-search',
    description: 'Searches the web for information.',
    category: 'retrieval',
    functionDefinition: {
      name: 'web_search',
      description: 'Perform a web search',
      parameters: { query: { type: 'string' } },
    },
    executionType: 'internal' as const,
    executionHandler: 'handlers/webSearch',
  };

  it('should accept a fully valid capability', () => {
    const result = createCapabilitySchema.safeParse(VALID_CAPABILITY);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should default requiresApproval=false and isActive=true', () => {
    const result = createCapabilitySchema.safeParse(VALID_CAPABILITY);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiresApproval).toBe(false);
      // test-review:accept tobe_true — boolean schema field `isActive`; asserting parsed default value
      expect(result.data.isActive).toBe(true);
    }
  });

  it('should reject an invalid executionType', () => {
    const result = createCapabilitySchema.safeParse({
      ...VALID_CAPABILITY,
      executionType: 'batch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject rateLimit above 10000', () => {
    const result = createCapabilitySchema.safeParse({ ...VALID_CAPABILITY, rateLimit: 10001 });
    expect(result.success).toBe(false);
  });

  it('should reject empty executionHandler', () => {
    const result = createCapabilitySchema.safeParse({
      ...VALID_CAPABILITY,
      executionHandler: '',
    });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// updateCapabilitySchema
// ────────────────────────────────────────────────────────────────────────────

describe('updateCapabilitySchema', () => {
  it('should accept an empty object (all fields optional)', () => {
    const result = updateCapabilitySchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should accept rateLimit: null to clear the rate limit', () => {
    const result = updateCapabilitySchema.safeParse({ rateLimit: null });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rateLimit).toBeNull();
    }
  });

  it('should reject empty category', () => {
    const result = updateCapabilitySchema.safeParse({ category: '' });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer rateLimit', () => {
    const result = updateCapabilitySchema.safeParse({ rateLimit: 10.5 });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// createWorkflowSchema
// ────────────────────────────────────────────────────────────────────────────

describe('createWorkflowSchema', () => {
  const VALID_WORKFLOW = {
    name: 'Research Workflow',
    slug: 'research-workflow',
    description: 'A workflow for automated research.',
    workflowDefinition: VALID_WORKFLOW_DEF,
  };

  it('should accept a fully valid workflow', () => {
    const result = createWorkflowSchema.safeParse(VALID_WORKFLOW);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should default patternsUsed=[], isActive=true, isTemplate=false', () => {
    const result = createWorkflowSchema.safeParse(VALID_WORKFLOW);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patternsUsed).toEqual([]);
      // test-review:accept tobe_true — boolean schema field `isActive`; asserting parsed default value
      expect(result.data.isActive).toBe(true);
      expect(result.data.isTemplate).toBe(false);
    }
  });

  it('should reject a workflowDefinition with no steps', () => {
    const result = createWorkflowSchema.safeParse({
      ...VALID_WORKFLOW,
      workflowDefinition: { ...VALID_WORKFLOW_DEF, steps: [] },
    });
    expect(result.success).toBe(false);
  });

  it('should reject an invalid errorStrategy', () => {
    const result = createWorkflowSchema.safeParse({
      ...VALID_WORKFLOW,
      workflowDefinition: { ...VALID_WORKFLOW_DEF, errorStrategy: 'ignore' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-positive pattern numbers in patternsUsed', () => {
    const result = createWorkflowSchema.safeParse({
      ...VALID_WORKFLOW,
      patternsUsed: [0],
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty name', () => {
    const result = createWorkflowSchema.safeParse({ ...VALID_WORKFLOW, name: '' });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// updateWorkflowSchema
// ────────────────────────────────────────────────────────────────────────────

describe('updateWorkflowSchema', () => {
  it('should accept an empty object (all fields optional)', () => {
    const result = updateWorkflowSchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should accept a partial update with only isTemplate', () => {
    const result = updateWorkflowSchema.safeParse({ isTemplate: true });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      // test-review:accept tobe_true — boolean schema field `isTemplate`; asserting explicit input value
      expect(result.data.isTemplate).toBe(true);
    }
  });

  it('should reject empty description', () => {
    const result = updateWorkflowSchema.safeParse({ description: '' });
    expect(result.success).toBe(false);
  });

  it('should accept "skip" as a valid errorStrategy in draftDefinition update', () => {
    const result = updateWorkflowSchema.safeParse({
      draftDefinition: { ...VALID_WORKFLOW_DEF, errorStrategy: 'skip' },
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should reject unknown errorStrategy values in draftDefinition update', () => {
    const result = updateWorkflowSchema.safeParse({
      draftDefinition: { ...VALID_WORKFLOW_DEF, errorStrategy: 'explode' },
    });
    expect(result.success).toBe(false);
  });

  it('should accept null draftDefinition (clears the draft via PATCH)', () => {
    const result = updateWorkflowSchema.safeParse({ draftDefinition: null });
    expect(result.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// workflowDefinitionSchema — errorStrategy enum includes 'skip'
// ────────────────────────────────────────────────────────────────────────────

describe('workflowDefinitionSchema', () => {
  it('accepts all four error strategies', () => {
    for (const strategy of ['retry', 'fallback', 'skip', 'fail'] as const) {
      const result = workflowDefinitionSchema.safeParse({
        ...VALID_WORKFLOW_DEF,
        errorStrategy: strategy,
      });
      expect(result.success, `expected "${strategy}" to be valid`).toBe(true);
    }
  });

  it('rejects an unknown errorStrategy', () => {
    const result = workflowDefinitionSchema.safeParse({
      ...VALID_WORKFLOW_DEF,
      errorStrategy: 'explode',
    });
    expect(result.success).toBe(false);
  });

  it('requires at least one step', () => {
    const result = workflowDefinitionSchema.safeParse({ ...VALID_WORKFLOW_DEF, steps: [] });
    expect(result.success).toBe(false);
  });

  it('requires a non-empty entryStepId', () => {
    const result = workflowDefinitionSchema.safeParse({ ...VALID_WORKFLOW_DEF, entryStepId: '' });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// publishWorkflowSchema
// ────────────────────────────────────────────────────────────────────────────

describe('publishWorkflowSchema', () => {
  it('accepts an empty body', () => {
    const result = publishWorkflowSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a body with a changeSummary', () => {
    const result = publishWorkflowSchema.safeParse({ changeSummary: 'Tweaked the prompt' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.changeSummary).toBe('Tweaked the prompt');
  });

  it('rejects a changeSummary longer than 500 chars', () => {
    const result = publishWorkflowSchema.safeParse({ changeSummary: 'a'.repeat(501) });
    expect(result.success).toBe(false);
  });

  it('trims whitespace on changeSummary', () => {
    const result = publishWorkflowSchema.safeParse({ changeSummary: '  notes  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.changeSummary).toBe('notes');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// rollbackWorkflowSchema
// ────────────────────────────────────────────────────────────────────────────

describe('rollbackWorkflowSchema', () => {
  const VALID_CUID_TARGET = 'cmjbv4i3x00003wsloputvv01';
  const VALID_UUID_TARGET = '8a2bd5ed-977e-4baa-a057-c85aeeff6cc4';

  it('accepts a valid CUID targetVersionId', () => {
    const result = rollbackWorkflowSchema.safeParse({ targetVersionId: VALID_CUID_TARGET });
    expect(result.success).toBe(true);
  });

  it('accepts a UUID targetVersionId (backfilled rows from the migration)', () => {
    const result = rollbackWorkflowSchema.safeParse({ targetVersionId: VALID_UUID_TARGET });
    expect(result.success).toBe(true);
  });

  it('accepts a body with both targetVersionId and changeSummary', () => {
    const result = rollbackWorkflowSchema.safeParse({
      targetVersionId: VALID_CUID_TARGET,
      changeSummary: 'Restoring the v3 wording',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when targetVersionId is missing', () => {
    const result = rollbackWorkflowSchema.safeParse({ changeSummary: 'oops' });
    expect(result.success).toBe(false);
  });

  it('rejects an arbitrary string that is neither CUID nor UUID', () => {
    const result = rollbackWorkflowSchema.safeParse({ targetVersionId: 'not-a-version-id' });
    expect(result.success).toBe(false);
  });

  it('rejects a CUID with the wrong prefix', () => {
    const result = rollbackWorkflowSchema.safeParse({
      targetVersionId: 'xjbv4i3x00003wsloputvv01',
    });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// chatMessageSchema
// ────────────────────────────────────────────────────────────────────────────

describe('chatMessageSchema', () => {
  const VALID_MESSAGE = {
    agentId: VALID_CUID,
    message: 'Hello, what can you help me with today?',
  };

  it('should accept a valid chat message', () => {
    const result = chatMessageSchema.safeParse(VALID_MESSAGE);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should accept optional conversationId, contextType, contextId', () => {
    const result = chatMessageSchema.safeParse({
      ...VALID_MESSAGE,
      conversationId: 'conv-123',
      contextType: 'document',
      contextId: 'doc-456',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.conversationId).toBe('conv-123');
    }
  });

  it('should reject an invalid agentId (not a CUID)', () => {
    const result = chatMessageSchema.safeParse({ ...VALID_MESSAGE, agentId: 'not-a-cuid' });
    expect(result.success).toBe(false);
  });

  it('should reject empty message', () => {
    const result = chatMessageSchema.safeParse({ ...VALID_MESSAGE, message: '' });
    expect(result.success).toBe(false);
  });

  it('should reject message longer than 50000 characters', () => {
    const result = chatMessageSchema.safeParse({ ...VALID_MESSAGE, message: 'x'.repeat(50001) });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// workflowExecutionSchema
// ────────────────────────────────────────────────────────────────────────────

describe('workflowExecutionSchema', () => {
  const VALID_EXECUTION = {
    workflowId: VALID_CUID,
    inputData: { query: 'test query' },
  };

  it('should accept a valid workflow execution request', () => {
    const result = workflowExecutionSchema.safeParse(VALID_EXECUTION);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should accept an optional budgetLimitUsd', () => {
    const result = workflowExecutionSchema.safeParse({ ...VALID_EXECUTION, budgetLimitUsd: 5.0 });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budgetLimitUsd).toBe(5.0);
    }
  });

  it('should reject an invalid workflowId', () => {
    const result = workflowExecutionSchema.safeParse({ ...VALID_EXECUTION, workflowId: 'bad-id' });
    expect(result.success).toBe(false);
  });

  it('should reject budgetLimitUsd above 1000', () => {
    const result = workflowExecutionSchema.safeParse({
      ...VALID_EXECUTION,
      budgetLimitUsd: 1001,
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-positive budgetLimitUsd', () => {
    const result = workflowExecutionSchema.safeParse({
      ...VALID_EXECUTION,
      budgetLimitUsd: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// evaluationSessionSchema
// ────────────────────────────────────────────────────────────────────────────

describe('evaluationSessionSchema', () => {
  const VALID_SESSION = {
    agentId: VALID_CUID,
    title: 'Baseline Evaluation',
  };

  it('should accept a valid evaluation session', () => {
    const result = evaluationSessionSchema.safeParse(VALID_SESSION);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should default status to draft', () => {
    const result = evaluationSessionSchema.safeParse(VALID_SESSION);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('draft');
    }
  });

  it('should accept all valid status values', () => {
    const statuses = ['draft', 'in_progress', 'completed', 'archived'] as const;
    for (const status of statuses) {
      const result = evaluationSessionSchema.safeParse({ ...VALID_SESSION, status });
      // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
      // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
      expect(result.success).toBe(true);
    }
  });

  it('should reject an invalid status', () => {
    const result = evaluationSessionSchema.safeParse({ ...VALID_SESSION, status: 'pending' });
    expect(result.success).toBe(false);
  });

  it('should reject title longer than 200 characters', () => {
    const result = evaluationSessionSchema.safeParse({ ...VALID_SESSION, title: 'a'.repeat(201) });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// knowledgeSearchSchema
// ────────────────────────────────────────────────────────────────────────────

describe('knowledgeSearchSchema', () => {
  it('should accept a valid search query', () => {
    const result = knowledgeSearchSchema.safeParse({ query: 'retry pattern' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should default limit to 10', () => {
    const result = knowledgeSearchSchema.safeParse({ query: 'retry pattern' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  it('should coerce numeric string for patternNumber and limit', () => {
    const result = knowledgeSearchSchema.safeParse({
      query: 'circuit breaker',
      patternNumber: '3',
      limit: '20',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patternNumber).toBe(3);
      expect(result.data.limit).toBe(20);
    }
  });

  it('should reject limit above 50', () => {
    const result = knowledgeSearchSchema.safeParse({ query: 'test', limit: 51 });
    expect(result.success).toBe(false);
  });

  it('should reject an invalid chunkType', () => {
    const result = knowledgeSearchSchema.safeParse({ query: 'test', chunkType: 'unknown_type' });
    expect(result.success).toBe(false);
  });

  it('should reject empty query', () => {
    const result = knowledgeSearchSchema.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// documentUploadSchema
// ────────────────────────────────────────────────────────────────────────────

describe('documentUploadSchema', () => {
  const VALID_DOCUMENT = {
    name: 'Agent Patterns',
    fileName: 'agent-patterns.md',
    fileHash: VALID_SHA256,
  };

  it('should accept a valid document upload', () => {
    const result = documentUploadSchema.safeParse(VALID_DOCUMENT);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should accept all whitelisted file extensions', () => {
    const extensions = ['md', 'txt', 'pdf', 'json', 'csv', 'html'];
    for (const ext of extensions) {
      const result = documentUploadSchema.safeParse({
        ...VALID_DOCUMENT,
        fileName: `file.${ext}`,
      });
      // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
      // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
      expect(result.success).toBe(true);
    }
  });

  it('should reject a disallowed file extension', () => {
    const result = documentUploadSchema.safeParse({ ...VALID_DOCUMENT, fileName: 'doc.xls' });
    expect(result.success).toBe(false);
  });

  it('should reject a fileHash shorter than 64 characters', () => {
    const result = documentUploadSchema.safeParse({ ...VALID_DOCUMENT, fileHash: 'a'.repeat(63) });
    expect(result.success).toBe(false);
  });

  it('should reject a fileHash with non-hex characters', () => {
    const result = documentUploadSchema.safeParse({
      ...VALID_DOCUMENT,
      fileHash: 'G'.repeat(64), // uppercase G is not a valid hex char
    });
    expect(result.success).toBe(false);
  });

  it('should reject a fileHash longer than 64 characters', () => {
    const result = documentUploadSchema.safeParse({ ...VALID_DOCUMENT, fileHash: 'a'.repeat(65) });
    expect(result.success).toBe(false);
  });

  it('should reject empty name', () => {
    const result = documentUploadSchema.safeParse({ ...VALID_DOCUMENT, name: '' });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// costQuerySchema
// ────────────────────────────────────────────────────────────────────────────

describe('costQuerySchema', () => {
  const VALID_COST_QUERY = {
    startDate: '2024-01-01',
    endDate: '2024-01-31',
  };

  it('should accept a valid cost query with date strings', () => {
    const result = costQuerySchema.safeParse(VALID_COST_QUERY);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should coerce date strings to Date objects', () => {
    const result = costQuerySchema.safeParse(VALID_COST_QUERY);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.startDate).toBeInstanceOf(Date);
      expect(result.data.endDate).toBeInstanceOf(Date);
    }
  });

  it('should accept an optional agentId as CUID', () => {
    const result = costQuerySchema.safeParse({ ...VALID_COST_QUERY, agentId: VALID_CUID });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe(VALID_CUID);
    }
  });

  it('should accept all valid operation values', () => {
    const operations = ['chat', 'tool_call', 'embedding', 'evaluation'] as const;
    for (const operation of operations) {
      const result = costQuerySchema.safeParse({ ...VALID_COST_QUERY, operation });
      // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
      // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
      expect(result.success).toBe(true);
    }
  });

  it('should reject an invalid operation', () => {
    const result = costQuerySchema.safeParse({ ...VALID_COST_QUERY, operation: 'batch' });
    expect(result.success).toBe(false);
  });

  it('should reject an invalid date string', () => {
    const result = costQuerySchema.safeParse({ ...VALID_COST_QUERY, startDate: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('should reject an agentId that is not a CUID', () => {
    const result = costQuerySchema.safeParse({ ...VALID_COST_QUERY, agentId: 'bad-id' });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// providerConfigSchema
// ────────────────────────────────────────────────────────────────────────────

describe('providerConfigSchema', () => {
  const VALID_PROVIDER = {
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic' as const,
  };

  it('should accept a valid provider config', () => {
    const result = providerConfigSchema.safeParse(VALID_PROVIDER);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should default isLocal=false and isActive=true', () => {
    const result = providerConfigSchema.safeParse(VALID_PROVIDER);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isLocal).toBe(false);
      // test-review:accept tobe_true — boolean schema field `isActive`; asserting parsed default value
      expect(result.data.isActive).toBe(true);
    }
  });

  it('should accept both valid providerType values', () => {
    const types = ['anthropic', 'openai-compatible'] as const;
    for (const providerType of types) {
      const result = providerConfigSchema.safeParse({ ...VALID_PROVIDER, providerType });
      // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
      // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
      expect(result.success).toBe(true);
    }
  });

  it('should reject an invalid providerType', () => {
    const result = providerConfigSchema.safeParse({ ...VALID_PROVIDER, providerType: 'gemini' });
    expect(result.success).toBe(false);
  });

  it('should accept a valid baseUrl', () => {
    const result = providerConfigSchema.safeParse({
      ...VALID_PROVIDER,
      baseUrl: 'https://api.anthropic.com',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should reject a non-URL baseUrl', () => {
    const result = providerConfigSchema.safeParse({
      ...VALID_PROVIDER,
      baseUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://127.0.0.1:11434/v1',
    'http://localhost:11434/v1',
    'http://[::1]/',
    'http://0.0.0.0/',
    'file:///etc/passwd',
    'gopher://evil/',
  ])('should reject SSRF-unsafe baseUrl %s', (baseUrl) => {
    const result = providerConfigSchema.safeParse({
      ...VALID_PROVIDER,
      isLocal: false,
      baseUrl,
    });
    expect(result.success).toBe(false);
  });

  it('accepts loopback baseUrl when isLocal=true', () => {
    const result = providerConfigSchema.safeParse({
      ...VALID_PROVIDER,
      isLocal: true,
      baseUrl: 'http://localhost:11434/v1',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('still rejects private IPs when isLocal=true', () => {
    const result = providerConfigSchema.safeParse({
      ...VALID_PROVIDER,
      isLocal: true,
      baseUrl: 'http://10.0.0.1/v1',
    });
    expect(result.success).toBe(false);
  });

  it('still rejects cloud metadata when isLocal=true', () => {
    const result = providerConfigSchema.safeParse({
      ...VALID_PROVIDER,
      isLocal: true,
      baseUrl: 'http://169.254.169.254/',
    });
    expect(result.success).toBe(false);
  });

  it('should accept a SCREAMING_SNAKE_CASE apiKeyEnvVar', () => {
    const result = providerConfigSchema.safeParse({
      ...VALID_PROVIDER,
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should reject a lowercase apiKeyEnvVar', () => {
    const result = providerConfigSchema.safeParse({
      ...VALID_PROVIDER,
      apiKeyEnvVar: 'anthropic_api_key',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty name', () => {
    const result = providerConfigSchema.safeParse({ ...VALID_PROVIDER, name: '' });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 3.1 — List query / history / pivot / export-import schemas
// ────────────────────────────────────────────────────────────────────────────

describe('listAgentsQuerySchema', () => {
  it('should accept empty query and apply pagination defaults', () => {
    const result = listAgentsQuerySchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBeGreaterThanOrEqual(1);
      expect(result.data.limit).toBeGreaterThan(0);
    }
  });

  it('should coerce isActive string to boolean', () => {
    const result = listAgentsQuerySchema.safeParse({ isActive: 'true', provider: 'anthropic' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) {
      // test-review:accept tobe_true — boolean schema field `isActive`; asserting coerced query param value
      expect(result.data.isActive).toBe(true);
      expect(result.data.provider).toBe('anthropic');
    }
  });

  it('should reject q longer than 200 chars', () => {
    const result = listAgentsQuerySchema.safeParse({ q: 'a'.repeat(201) });
    expect(result.success).toBe(false);
  });
});

describe('listCapabilitiesQuerySchema', () => {
  it('should accept valid executionType filter', () => {
    const result = listCapabilitiesQuerySchema.safeParse({ executionType: 'internal' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should reject unknown executionType', () => {
    const result = listCapabilitiesQuerySchema.safeParse({ executionType: 'bogus' });
    expect(result.success).toBe(false);
  });
});

describe('systemInstructionsHistoryEntrySchema', () => {
  const VALID_ENTRY = {
    instructions: 'You are a helpful assistant.',
    changedAt: '2026-04-10T12:00:00.000Z',
    changedBy: 'user_abc123',
  };

  it('should accept a valid history entry', () => {
    expect(systemInstructionsHistoryEntrySchema.safeParse(VALID_ENTRY).success).toBe(true);
  });

  it('should reject empty instructions', () => {
    const result = systemInstructionsHistoryEntrySchema.safeParse({
      ...VALID_ENTRY,
      instructions: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-ISO changedAt', () => {
    const result = systemInstructionsHistoryEntrySchema.safeParse({
      ...VALID_ENTRY,
      changedAt: 'yesterday',
    });
    expect(result.success).toBe(false);
  });
});

describe('systemInstructionsHistorySchema', () => {
  it('should accept an empty array', () => {
    expect(systemInstructionsHistorySchema.safeParse([]).success).toBe(true);
  });

  it('should accept an array of valid entries', () => {
    const result = systemInstructionsHistorySchema.safeParse([
      {
        instructions: 'v1',
        changedAt: '2026-04-10T12:00:00.000Z',
        changedBy: 'user_abc123',
      },
      {
        instructions: 'v2',
        changedAt: '2026-04-10T13:00:00.000Z',
        changedBy: 'user_abc123',
      },
    ]);
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should reject non-array input', () => {
    expect(systemInstructionsHistorySchema.safeParse({ nope: true }).success).toBe(false);
  });
});

describe('instructionsRevertSchema', () => {
  it('should accept a valid non-negative integer', () => {
    expect(instructionsRevertSchema.safeParse({ versionIndex: 0 }).success).toBe(true);
    expect(instructionsRevertSchema.safeParse({ versionIndex: 7 }).success).toBe(true);
  });

  it('should reject negative index', () => {
    expect(instructionsRevertSchema.safeParse({ versionIndex: -1 }).success).toBe(false);
  });

  it('should reject non-integer index', () => {
    expect(instructionsRevertSchema.safeParse({ versionIndex: 1.5 }).success).toBe(false);
  });
});

describe('attachAgentCapabilitySchema', () => {
  it('should accept a minimal valid attach body', () => {
    const result = attachAgentCapabilitySchema.safeParse({ capabilityId: VALID_CUID });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    // test-review:accept tobe_true — boolean schema field `isEnabled`; asserting parsed default value
    if (result.success) expect(result.data.isEnabled).toBe(true);
  });

  it('should reject an invalid capabilityId', () => {
    expect(attachAgentCapabilitySchema.safeParse({ capabilityId: 'not-a-cuid' }).success).toBe(
      false
    );
  });

  it('should accept customConfig and customRateLimit', () => {
    const result = attachAgentCapabilitySchema.safeParse({
      capabilityId: VALID_CUID,
      isEnabled: false,
      customConfig: { maxItems: 10 },
      customRateLimit: 30,
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should reject customRateLimit above max', () => {
    const result = attachAgentCapabilitySchema.safeParse({
      capabilityId: VALID_CUID,
      customRateLimit: 999999,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateAgentCapabilitySchema', () => {
  it('should reject an empty object (at least one field required)', () => {
    expect(updateAgentCapabilitySchema.safeParse({}).success).toBe(false);
  });

  it('should accept a partial update', () => {
    expect(
      updateAgentCapabilitySchema.safeParse({ isEnabled: false, customRateLimit: null }).success
    ).toBe(true);
  });

  it('should reject customRateLimit of 0', () => {
    expect(updateAgentCapabilitySchema.safeParse({ customRateLimit: 0 }).success).toBe(false);
  });
});

describe('exportAgentsSchema', () => {
  it('should accept a single-id body', () => {
    expect(exportAgentsSchema.safeParse({ agentIds: [VALID_CUID] }).success).toBe(true);
  });

  it('should reject an empty array', () => {
    expect(exportAgentsSchema.safeParse({ agentIds: [] }).success).toBe(false);
  });

  it('should reject more than 100 ids', () => {
    expect(exportAgentsSchema.safeParse({ agentIds: Array(101).fill(VALID_CUID) }).success).toBe(
      false
    );
  });

  it('should reject non-cuid ids', () => {
    expect(exportAgentsSchema.safeParse({ agentIds: ['not-a-cuid'] }).success).toBe(false);
  });
});

describe('agentBundleSchema', () => {
  const VALID_BUNDLE = {
    version: '1' as const,
    exportedAt: '2026-04-10T12:00:00.000Z',
    agents: [
      {
        name: 'Test Agent',
        slug: 'test-agent',
        description: 'A test agent',
        systemInstructions: 'You are a helpful assistant.',
        systemInstructionsHistory: [],
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        temperature: 0.7,
        maxTokens: 4096,
        isActive: true,
        capabilities: [],
      },
    ],
  };

  it('should accept a minimal valid bundle', () => {
    expect(agentBundleSchema.safeParse(VALID_BUNDLE).success).toBe(true);
  });

  it('should reject an unsupported version', () => {
    expect(agentBundleSchema.safeParse({ ...VALID_BUNDLE, version: '2' }).success).toBe(false);
  });

  it('should reject an empty agents array', () => {
    expect(agentBundleSchema.safeParse({ ...VALID_BUNDLE, agents: [] }).success).toBe(false);
  });

  it('should accept an agent with capabilities by slug', () => {
    const result = agentBundleSchema.safeParse({
      ...VALID_BUNDLE,
      agents: [
        {
          ...VALID_BUNDLE.agents[0],
          capabilities: [
            { slug: 'search-web', isEnabled: true },
            { slug: 'read-file', isEnabled: false, customRateLimit: 10 },
          ],
        },
      ],
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });
});

describe('importAgentsSchema', () => {
  const MINIMAL_BUNDLE = {
    version: '1' as const,
    exportedAt: '2026-04-10T12:00:00.000Z',
    agents: [
      {
        name: 'Test Agent',
        slug: 'test-agent',
        description: 'A test agent',
        systemInstructions: 'You are a helpful assistant.',
        systemInstructionsHistory: [],
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        temperature: 0.7,
        maxTokens: 4096,
        isActive: true,
        capabilities: [],
      },
    ],
  };

  it('should default conflictMode to skip', () => {
    const result = importAgentsSchema.safeParse({ bundle: MINIMAL_BUNDLE });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.conflictMode).toBe('skip');
  });

  it('should accept conflictMode overwrite', () => {
    const result = importAgentsSchema.safeParse({
      bundle: MINIMAL_BUNDLE,
      conflictMode: 'overwrite',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('should reject unknown conflictMode', () => {
    const result = importAgentsSchema.safeParse({
      bundle: MINIMAL_BUNDLE,
      conflictMode: 'merge',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a missing bundle', () => {
    expect(importAgentsSchema.safeParse({ conflictMode: 'skip' }).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// updateProviderConfigSchema
// ────────────────────────────────────────────────────────────────────────────

describe('updateProviderConfigSchema', () => {
  it('accepts a partial update with just name', () => {
    const result = updateProviderConfigSchema.safeParse({ name: 'New Name' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts nullable apiKeyEnvVar and baseUrl', () => {
    const result = updateProviderConfigSchema.safeParse({
      apiKeyEnvVar: null,
      baseUrl: null,
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects apiKeyEnvVar that is not SCREAMING_SNAKE_CASE', () => {
    const result = updateProviderConfigSchema.safeParse({ apiKeyEnvVar: 'lowercase_key' });
    expect(result.success).toBe(false);
  });

  it('rejects an SSRF-unsafe baseUrl on update', () => {
    const result = updateProviderConfigSchema.safeParse({
      baseUrl: 'http://169.254.169.254/',
    });
    expect(result.success).toBe(false);
  });

  it('rejects loopback baseUrl on update without isLocal', () => {
    const result = updateProviderConfigSchema.safeParse({
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(result.success).toBe(false);
  });

  it('accepts loopback baseUrl on update when isLocal=true is also set', () => {
    const result = updateProviderConfigSchema.safeParse({
      baseUrl: 'http://localhost:11434/v1',
      isLocal: true,
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// listProvidersQuerySchema
// ────────────────────────────────────────────────────────────────────────────

describe('listProvidersQuerySchema', () => {
  it('accepts an empty query (pagination defaults)', () => {
    const result = listProvidersQuerySchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('coerces isActive string to boolean and accepts providerType', () => {
    const result = listProvidersQuerySchema.safeParse({
      isActive: 'true',
      providerType: 'anthropic',
      q: 'claude',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects an unknown providerType', () => {
    const result = listProvidersQuerySchema.safeParse({ providerType: 'not-a-provider' });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// listWorkflowsQuerySchema
// ────────────────────────────────────────────────────────────────────────────

describe('listWorkflowsQuerySchema', () => {
  it('accepts filters for isActive, isTemplate, and q', () => {
    const result = listWorkflowsQuerySchema.safeParse({
      isActive: 'true',
      isTemplate: 'false',
      q: 'onboarding',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects q longer than 200 characters', () => {
    const result = listWorkflowsQuerySchema.safeParse({ q: 'a'.repeat(201) });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// listExecutionsQuerySchema
// ────────────────────────────────────────────────────────────────────────────

describe('listExecutionsQuerySchema', () => {
  it('accepts workflowId, status, and ISO date strings', () => {
    const result = listExecutionsQuerySchema.safeParse({
      workflowId: VALID_CUID,
      status: 'running',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const result = listExecutionsQuerySchema.safeParse({ status: 'exploded' });
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// executeWorkflowBodySchema
// ────────────────────────────────────────────────────────────────────────────

describe('executeWorkflowBodySchema', () => {
  it('accepts inputData alone', () => {
    const result = executeWorkflowBodySchema.safeParse({ inputData: { topic: 'test' } });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts inputData with a positive budgetLimitUsd', () => {
    const result = executeWorkflowBodySchema.safeParse({
      inputData: {},
      budgetLimitUsd: 5.5,
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects a negative budgetLimitUsd', () => {
    const result = executeWorkflowBodySchema.safeParse({
      inputData: {},
      budgetLimitUsd: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing inputData', () => {
    const result = executeWorkflowBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// approveExecutionBodySchema
// ────────────────────────────────────────────────────────────────────────────

describe('approveExecutionBodySchema', () => {
  it('accepts an empty body', () => {
    const result = approveExecutionBodySchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts an approvalPayload and notes', () => {
    const result = approveExecutionBodySchema.safeParse({
      approvalPayload: { decision: 'approved' },
      notes: 'Looks good',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects notes longer than 5000 characters', () => {
    const result = approveExecutionBodySchema.safeParse({ notes: 'x'.repeat(5001) });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Session 3.3 — Chat stream / Knowledge / Conversations
// ============================================================================

describe('chatStreamRequestSchema', () => {
  it('accepts a minimal valid body', () => {
    const result = chatStreamRequestSchema.safeParse({
      message: 'hello',
      agentSlug: 'default-agent',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts an optional CUID conversationId and contextType/contextId', () => {
    const result = chatStreamRequestSchema.safeParse({
      message: 'hi',
      agentSlug: 'coach',
      conversationId: 'clh1234567890abcdefghijkl',
      contextType: 'pattern',
      contextId: 'pattern-1',
      entityContext: { foo: 'bar' },
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects an empty message', () => {
    const result = chatStreamRequestSchema.safeParse({ message: '', agentSlug: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects messages longer than 50_000 characters', () => {
    const result = chatStreamRequestSchema.safeParse({
      message: 'a'.repeat(50_001),
      agentSlug: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('requires agentSlug', () => {
    const result = chatStreamRequestSchema.safeParse({ message: 'hi' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only messages after trim', () => {
    const result = chatStreamRequestSchema.safeParse({
      message: '     ',
      agentSlug: 'test-agent',
    });
    expect(result.success).toBe(false);
  });
});

describe('listConversationsQuerySchema', () => {
  it('accepts pagination defaults and no filters', () => {
    const result = listConversationsQuerySchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('coerces string "true" / "false" into boolean for isActive', () => {
    const result = listConversationsQuerySchema.safeParse({ isActive: 'true' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    expect(result.success && result.data.isActive).toBe(true);
  });

  it('accepts q substring filter', () => {
    const result = listConversationsQuerySchema.safeParse({ q: 'test search' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects a non-CUID agentId', () => {
    const result = listConversationsQuerySchema.safeParse({ agentId: 'not-a-cuid' });
    expect(result.success).toBe(false);
  });
});

describe('clearConversationsBodySchema', () => {
  it('rejects an empty body (no filters)', () => {
    const result = clearConversationsBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts an ISO olderThan alone', () => {
    const result = clearConversationsBodySchema.safeParse({
      olderThan: '2025-01-01T00:00:00Z',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts an agentId alone', () => {
    const result = clearConversationsBodySchema.safeParse({
      agentId: 'clh1234567890abcdefghijkl',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects an invalid ISO datetime', () => {
    const result = clearConversationsBodySchema.safeParse({ olderThan: 'yesterday' });
    expect(result.success).toBe(false);
  });

  it('accepts a target userId alongside a filter', () => {
    const result = clearConversationsBodySchema.safeParse({
      agentId: 'clh1234567890abcdefghijkl',
      userId: 'clh9876543210abcdefghijkl',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts allUsers:true alongside a filter', () => {
    const result = clearConversationsBodySchema.safeParse({
      olderThan: '2025-01-01T00:00:00Z',
      allUsers: true,
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects allUsers:true alone (no narrowing filter)', () => {
    const result = clearConversationsBodySchema.safeParse({ allUsers: true });
    expect(result.success).toBe(false);
  });

  it('rejects userId combined with allUsers:true', () => {
    const result = clearConversationsBodySchema.safeParse({
      olderThan: '2025-01-01T00:00:00Z',
      userId: 'clh1234567890abcdefghijkl',
      allUsers: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('listDocumentsQuerySchema', () => {
  it('accepts the default pagination with no filters', () => {
    const result = listDocumentsQuerySchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts a valid status enum value', () => {
    const result = listDocumentsQuerySchema.safeParse({ status: 'ready' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects an invalid status enum value', () => {
    const result = listDocumentsQuerySchema.safeParse({ status: 'archived' });
    expect(result.success).toBe(false);
  });
});

describe('getPatternParamSchema', () => {
  it('coerces a numeric string into a positive integer', () => {
    const result = getPatternParamSchema.safeParse({ number: '12' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    expect(result.success && result.data.number).toBe(12);
  });

  it('rejects non-numeric input', () => {
    const result = getPatternParamSchema.safeParse({ number: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects zero and negative numbers', () => {
    expect(getPatternParamSchema.safeParse({ number: '0' }).success).toBe(false);
    expect(getPatternParamSchema.safeParse({ number: '-1' }).success).toBe(false);
  });
});

// ============================================================================
// Session 3.4 — Costs & Evaluations
// ============================================================================

describe('costBreakdownQuerySchema', () => {
  it('accepts a valid request with ISO date strings', () => {
    const result = costBreakdownQuerySchema.safeParse({
      dateFrom: '2026-01-01',
      dateTo: '2026-02-01',
      groupBy: 'day',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts an optional agentId filter', () => {
    const result = costBreakdownQuerySchema.safeParse({
      agentId: VALID_CUID,
      dateFrom: '2026-01-01',
      dateTo: '2026-01-02',
      groupBy: 'model',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects a non-CUID agentId', () => {
    const result = costBreakdownQuerySchema.safeParse({
      agentId: 'not-a-cuid',
      dateFrom: '2026-01-01',
      dateTo: '2026-01-02',
      groupBy: 'agent',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when dateFrom is after dateTo', () => {
    const result = costBreakdownQuerySchema.safeParse({
      dateFrom: '2026-02-01',
      dateTo: '2026-01-01',
      groupBy: 'day',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a span longer than 366 days', () => {
    const result = costBreakdownQuerySchema.safeParse({
      dateFrom: '2024-01-01',
      dateTo: '2026-01-01',
      groupBy: 'day',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown groupBy value', () => {
    const result = costBreakdownQuerySchema.safeParse({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-02',
      groupBy: 'month',
    });
    expect(result.success).toBe(false);
  });

  it('requires groupBy', () => {
    const result = costBreakdownQuerySchema.safeParse({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-02',
    });
    expect(result.success).toBe(false);
  });
});

describe('listEvaluationsQuerySchema', () => {
  it('accepts pagination defaults with no filters', () => {
    const result = listEvaluationsQuerySchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts agentId + status + q filters', () => {
    const result = listEvaluationsQuerySchema.safeParse({
      agentId: VALID_CUID,
      status: 'in_progress',
      q: 'retention',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects a non-CUID agentId', () => {
    const result = listEvaluationsQuerySchema.safeParse({ agentId: 'not-a-cuid' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown status', () => {
    const result = listEvaluationsQuerySchema.safeParse({ status: 'hmm' });
    expect(result.success).toBe(false);
  });
});

describe('createEvaluationSchema', () => {
  it('accepts a minimal valid body', () => {
    const result = createEvaluationSchema.safeParse({
      agentId: VALID_CUID,
      title: 'Retention probe',
    });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects a missing agentId', () => {
    const result = createEvaluationSchema.safeParse({ title: 'hi' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty title', () => {
    const result = createEvaluationSchema.safeParse({ agentId: VALID_CUID, title: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a description longer than 5000 chars', () => {
    const result = createEvaluationSchema.safeParse({
      agentId: VALID_CUID,
      title: 'x',
      description: 'y'.repeat(5001),
    });
    expect(result.success).toBe(false);
  });

  it('does not accept a status field (completion is separate)', () => {
    const result = createEvaluationSchema.safeParse({
      agentId: VALID_CUID,
      title: 'x',
      status: 'completed',
    });
    // status is stripped (ignored) because schema is not .strict()
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    expect(result.success && 'status' in result.data).toBe(false);
  });
});

describe('updateEvaluationSchema', () => {
  it('rejects an empty body (no fields provided)', () => {
    const result = updateEvaluationSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts a single title change', () => {
    const result = updateEvaluationSchema.safeParse({ title: 'New title' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts a status transition to in_progress', () => {
    const result = updateEvaluationSchema.safeParse({ status: 'in_progress' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('rejects status=completed (must use /complete endpoint)', () => {
    const result = updateEvaluationSchema.safeParse({ status: 'completed' });
    expect(result.success).toBe(false);
  });
});

describe('evaluationLogsQuerySchema', () => {
  it('applies default limit of 100 when omitted', () => {
    const result = evaluationLogsQuerySchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(100);
  });

  it('coerces a numeric string limit', () => {
    const result = evaluationLogsQuerySchema.safeParse({ limit: '25' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(25);
  });

  it('rejects a limit above 500', () => {
    const result = evaluationLogsQuerySchema.safeParse({ limit: '501' });
    expect(result.success).toBe(false);
  });

  it('accepts an optional before cursor (positive integer sequenceNumber)', () => {
    const result = evaluationLogsQuerySchema.safeParse({ before: 42 });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    expect(result.success && result.data.before).toBe(42);
  });

  it('coerces a numeric-string before cursor', () => {
    const result = evaluationLogsQuerySchema.safeParse({ before: '7' });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
    expect(result.success && result.data.before).toBe(7);
  });

  it('rejects a non-numeric before cursor', () => {
    const result = evaluationLogsQuerySchema.safeParse({ before: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects a zero or negative before cursor', () => {
    expect(evaluationLogsQuerySchema.safeParse({ before: 0 }).success).toBe(false);
    expect(evaluationLogsQuerySchema.safeParse({ before: -5 }).success).toBe(false);
  });
});

describe('completeEvaluationBodySchema', () => {
  it('accepts an empty body', () => {
    const result = completeEvaluationBodySchema.safeParse({});
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });

  it('accepts unknown extra fields (passthrough for forward compat)', () => {
    const result = completeEvaluationBodySchema.safeParse({ futureOption: true });
    // test-review:accept tobe_true — structural assertion on Zod safeParse success field; valid-input contract check
    expect(result.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// executionStatusSchema
// ────────────────────────────────────────────────────────────────────────────

describe('executionStatusSchema', () => {
  it.each(['pending', 'running', 'paused_for_approval', 'completed', 'failed', 'cancelled'])(
    'accepts valid status "%s"',
    (status) => {
      expect(executionStatusSchema.safeParse(status).success).toBe(true);
    }
  );

  it('rejects invalid status values', () => {
    expect(executionStatusSchema.safeParse('unknown').success).toBe(false);
    expect(executionStatusSchema.safeParse('').success).toBe(false);
    expect(executionStatusSchema.safeParse(123).success).toBe(false);
  });
});

describe('executionTraceSchema', () => {
  it('parses valid trace entries', () => {
    const trace = [
      {
        stepId: 'step-1',
        stepType: 'llm_call',
        label: 'Generate',
        status: 'completed',
        output: { text: 'hi' },
        tokensUsed: 100,
        costUsd: 0.01,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:01Z',
        durationMs: 1000,
      },
    ];
    const result = executionTraceSchema.parse(trace);
    expect(result).toHaveLength(1);
    expect(result[0].stepId).toBe('step-1');
  });

  it('returns empty array and logs warning for malformed trace', async () => {
    const { logger } = vi.mocked(await import('@/lib/logging'));
    vi.clearAllMocks();

    const result = executionTraceSchema.parse('not-an-array');
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Malformed execution trace'),
      expect.any(Object)
    );
  });

  it('parses historical trace rows that lack the new optional latency fields', () => {
    // Forwards-compat: rows written before the trace-viewer work omit
    // input/model/provider/inputTokens/outputTokens/llmDurationMs entirely.
    const historical = [
      {
        stepId: 'step-1',
        stepType: 'llm_call',
        label: 'Generate',
        status: 'completed',
        output: { text: 'hi' },
        tokensUsed: 100,
        costUsd: 0.01,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:01Z',
        durationMs: 1000,
      },
    ];
    const result = executionTraceSchema.parse(historical);
    expect(result).toHaveLength(1);
    expect(result[0].input).toBeUndefined();
    expect(result[0].model).toBeUndefined();
    expect(result[0].provider).toBeUndefined();
    expect(result[0].inputTokens).toBeUndefined();
    expect(result[0].outputTokens).toBeUndefined();
    expect(result[0].llmDurationMs).toBeUndefined();
  });

  it('parses new-shape trace rows with the optional latency fields populated', () => {
    const newShape = [
      {
        stepId: 'step-1',
        stepType: 'llm_call',
        label: 'Generate',
        status: 'completed',
        output: { text: 'hi' },
        tokensUsed: 150,
        costUsd: 0.05,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:01Z',
        durationMs: 1000,
        input: { prompt: 'hello' },
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        llmDurationMs: 850,
      },
    ];
    const result = executionTraceSchema.parse(newShape);
    expect(result[0].model).toBe('gpt-4o-mini');
    expect(result[0].provider).toBe('openai');
    expect(result[0].inputTokens).toBe(100);
    expect(result[0].outputTokens).toBe(50);
    expect(result[0].llmDurationMs).toBe(850);
    expect(result[0].input).toEqual({ prompt: 'hello' });
  });

  it('falls through to empty array when one entry is malformed (whole-array catch)', async () => {
    const { logger } = vi.mocked(await import('@/lib/logging'));
    vi.clearAllMocks();

    // Mixed: first entry valid, second entry has wrong type for inputTokens.
    const mixed = [
      {
        stepId: 'step-1',
        stepType: 'llm_call',
        label: 'Generate',
        status: 'completed',
        output: null,
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2026-01-01T00:00:00Z',
        durationMs: 100,
      },
      {
        stepId: 'step-2',
        stepType: 'llm_call',
        label: 'Generate',
        status: 'completed',
        output: null,
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2026-01-01T00:00:01Z',
        durationMs: 200,
        inputTokens: 'not-a-number',
      },
    ];
    const result = executionTraceSchema.parse(mixed);
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rejects negative inputTokens / outputTokens / llmDurationMs in entry-level parse', () => {
    const bad = {
      stepId: 'step-1',
      stepType: 'llm_call',
      label: 'Generate',
      status: 'completed',
      output: null,
      tokensUsed: 0,
      costUsd: 0,
      startedAt: '2026-01-01T00:00:00Z',
      durationMs: 100,
      inputTokens: -1,
    };
    // The entry-level schema MUST reject negatives. The whole-array
    // schema would .catch() and return empty, so we test the entry directly.
    const result = executionTraceEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('preserves unknown fields on parse (forward-compat for resume re-checkpoint)', () => {
    // If a future engine version adds a field, persists it, and is then
    // read by older code on the resume path, that field must survive the
    // parse → re-checkpoint round-trip rather than being silently stripped.
    const futureEntry = {
      stepId: 'step-1',
      stepType: 'llm_call',
      label: 'Generate',
      status: 'completed',
      output: null,
      tokensUsed: 0,
      costUsd: 0,
      startedAt: '2026-01-01T00:00:00Z',
      durationMs: 100,
      futureField: 'should-survive',
      anotherFuture: { nested: true },
    };
    const result = executionTraceEntrySchema.parse(futureEntry);
    expect((result as Record<string, unknown>).futureField).toBe('should-survive');
    expect((result as Record<string, unknown>).anotherFuture).toEqual({ nested: true });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// chatAttachmentSchema
// ────────────────────────────────────────────────────────────────────────────

describe('chatAttachmentSchema', () => {
  const validAttachment = {
    name: 'photo.jpg',
    mediaType: 'image/jpeg' as const,
    data: 'iVBORw0KGgoAAAANSUhEUg==',
  };

  it('accepts valid attachment', () => {
    expect(() => chatAttachmentSchema.parse(validAttachment)).not.toThrow();
  });

  it('rejects attachment data exceeding 10MB', () => {
    const oversized = { ...validAttachment, data: 'x'.repeat(10_000_001) };
    const result = chatAttachmentSchema.safeParse(oversized);
    expect(result.success).toBe(false);
  });

  it('accepts attachment data at exactly 10MB', () => {
    const atLimit = { ...validAttachment, data: 'x'.repeat(10_000_000) };
    expect(() => chatAttachmentSchema.parse(atLimit)).not.toThrow();
  });

  it('rejects empty data', () => {
    const empty = { ...validAttachment, data: '' };
    const result = chatAttachmentSchema.safeParse(empty);
    expect(result.success).toBe(false);
  });

  it('rejects unsupported media type', () => {
    const bad = { ...validAttachment, mediaType: 'video/mp4' };
    const result = chatAttachmentSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// searchConfigSchema (knowledge-search weight configuration)
// ────────────────────────────────────────────────────────────────────────────

describe('searchConfigSchema', () => {
  it('accepts the legacy two-field shape (back-compat with rows persisted before hybrid)', () => {
    const legacy = { keywordBoostWeight: -0.02, vectorWeight: 1.0 };
    const result = searchConfigSchema.safeParse(legacy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keywordBoostWeight).toBe(-0.02);
      expect(result.data.vectorWeight).toBe(1.0);
      expect(result.data.hybridEnabled).toBeUndefined();
      expect(result.data.bm25Weight).toBeUndefined();
    }
  });

  it('accepts the new shape with hybridEnabled and bm25Weight', () => {
    const hybrid = {
      keywordBoostWeight: -0.02,
      vectorWeight: 1.0,
      hybridEnabled: true,
      bm25Weight: 0.5,
    };
    const result = searchConfigSchema.safeParse(hybrid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hybridEnabled).toBe(true);
      expect(result.data.bm25Weight).toBe(0.5);
    }
  });

  it('accepts hybridEnabled without bm25Weight (form may default at submit time)', () => {
    const partial = {
      keywordBoostWeight: -0.02,
      vectorWeight: 1.0,
      hybridEnabled: true,
    };
    expect(() => searchConfigSchema.parse(partial)).not.toThrow();
  });

  it('rejects bm25Weight above 2.0', () => {
    const oversized = {
      keywordBoostWeight: -0.02,
      vectorWeight: 1.0,
      hybridEnabled: true,
      bm25Weight: 5,
    };
    const result = searchConfigSchema.safeParse(oversized);
    expect(result.success).toBe(false);
  });

  it('rejects bm25Weight below 0.1', () => {
    const undersized = {
      keywordBoostWeight: -0.02,
      vectorWeight: 1.0,
      hybridEnabled: true,
      bm25Weight: 0.01,
    };
    const result = searchConfigSchema.safeParse(undersized);
    expect(result.success).toBe(false);
  });

  it('rejects vectorWeight outside the 0.1–2.0 band (existing rule preserved)', () => {
    const bad = { keywordBoostWeight: -0.02, vectorWeight: 5 };
    const result = searchConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects positive keywordBoostWeight (existing rule preserved)', () => {
    const bad = { keywordBoostWeight: 0.5, vectorWeight: 1.0 };
    const result = searchConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('accepts a hybrid-only override without legacy weights (the form must be able to send this)', () => {
    const hybridOnly = { hybridEnabled: true, bm25Weight: 1.0 };
    const result = searchConfigSchema.safeParse(hybridOnly);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keywordBoostWeight).toBeUndefined();
      expect(result.data.vectorWeight).toBeUndefined();
      expect(result.data.hybridEnabled).toBe(true);
      expect(result.data.bm25Weight).toBe(1.0);
    }
  });

  it('accepts a single-field override (vectorWeight only)', () => {
    const result = searchConfigSchema.safeParse({ vectorWeight: 1.5 });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object (treated as all-defaults)', () => {
    const result = searchConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('widgetConfigSchema', () => {
  function validBase() {
    return {
      primaryColor: '#2563eb',
      surfaceColor: '#ffffff',
      textColor: '#111827',
      fontFamily: 'Inter, sans-serif',
      headerTitle: 'Chat',
      headerSubtitle: '',
      inputPlaceholder: 'Type a message…',
      sendLabel: 'Send',
      conversationStarters: [],
      footerText: '',
    };
  }

  it('accepts a fully-resolved valid config', () => {
    const result = widgetConfigSchema.safeParse(validBase());
    expect(result.success).toBe(true);
  });

  it('rejects 3-digit hex colour shorthand (full 6-digit form required)', () => {
    const bad = { ...validBase(), primaryColor: '#abc' };
    const result = widgetConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects non-hex colour values', () => {
    const bad = { ...validBase(), surfaceColor: 'rgb(255,255,255)' };
    const result = widgetConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects font-family containing CSS-injection metacharacters', () => {
    const bad = { ...validBase(), fontFamily: 'Inter; color: red' };
    const result = widgetConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects font-family containing curly braces', () => {
    const bad = { ...validBase(), fontFamily: 'Inter} {body{display:none}' };
    const result = widgetConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('accepts a font stack with quoted family names', () => {
    const ok = { ...validBase(), fontFamily: '"Helvetica Neue", Arial, sans-serif' };
    const result = widgetConfigSchema.safeParse(ok);
    expect(result.success).toBe(true);
  });

  it('rejects header longer than 60 chars', () => {
    const bad = { ...validBase(), headerTitle: 'a'.repeat(61) };
    const result = widgetConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects empty header (a header is required when set)', () => {
    const bad = { ...validBase(), headerTitle: '' };
    const result = widgetConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('accepts up to 4 conversation starters', () => {
    const ok = { ...validBase(), conversationStarters: ['a', 'b', 'c', 'd'] };
    const result = widgetConfigSchema.safeParse(ok);
    expect(result.success).toBe(true);
  });

  it('rejects more than 4 conversation starters', () => {
    const bad = { ...validBase(), conversationStarters: ['a', 'b', 'c', 'd', 'e'] };
    const result = widgetConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects empty starter strings', () => {
    const bad = { ...validBase(), conversationStarters: [''] };
    const result = widgetConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('updateWidgetConfigSchema (PATCH body)', () => {
  it('rejects an empty body', () => {
    const result = updateWidgetConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts a single-field update', () => {
    const result = updateWidgetConfigSchema.safeParse({ primaryColor: '#16a34a' });
    expect(result.success).toBe(true);
  });

  it('rejects unknown extra fields when the rest are valid (zod strict by default? — actually accepts; assert merge behaviour instead)', () => {
    // zod object is non-strict; unknown keys pass through validation but are
    // dropped on parse output. The contract for the PATCH route is that only
    // known keys are persisted via resolveWidgetConfig — this test pins that.
    const result = updateWidgetConfigSchema.safeParse({
      primaryColor: '#16a34a',
      bogusField: 'x',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).bogusField).toBeUndefined();
    }
  });
});

describe('resolveWidgetConfig', () => {
  it('returns full defaults when stored value is null', () => {
    const out = resolveWidgetConfig(null);
    expect(out).toEqual(DEFAULT_WIDGET_CONFIG);
  });

  it('returns full defaults when stored value is undefined', () => {
    const out = resolveWidgetConfig(undefined);
    expect(out).toEqual(DEFAULT_WIDGET_CONFIG);
  });

  it('merges a partial stored value over defaults', () => {
    const out = resolveWidgetConfig({ primaryColor: '#16a34a', headerTitle: 'Council' });
    expect(out.primaryColor).toBe('#16a34a');
    expect(out.headerTitle).toBe('Council');
    expect(out.sendLabel).toBe(DEFAULT_WIDGET_CONFIG.sendLabel);
  });

  it('falls back to defaults if a stored field is invalid', () => {
    // A stored value that fails schema validation (e.g. legacy bad data)
    // must not crash the widget — we return defaults instead.
    const out = resolveWidgetConfig({ primaryColor: 'not-a-colour' });
    expect(out).toEqual(DEFAULT_WIDGET_CONFIG);
  });

  it('ignores unknown stored fields', () => {
    const out = resolveWidgetConfig({ primaryColor: '#16a34a', legacy: 'ignored' });
    expect(out.primaryColor).toBe('#16a34a');
    expect((out as Record<string, unknown>).legacy).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// turnEntrySchema / turnEntriesSchema (PR 2 additions)
// ────────────────────────────────────────────────────────────────────────────

describe('turnEntrySchema', () => {
  it('accepts agent_call terminal-phase shape (no toolCall/toolResult)', () => {
    // Arrange
    const input = {
      kind: 'agent_call',
      phase: 'terminal',
      index: 0,
      assistantContent: 'hi',
      tokensUsed: 100,
      costUsd: 0.01,
    };

    // Act
    const result = turnEntrySchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'agent_call') {
      expect(result.data.phase).toBe('terminal');
      expect(result.data.index).toBe(0);
      expect(result.data.tokensUsed).toBe(100);
      // Terminal phase: toolCall/toolResult must NOT be on the parsed shape
      expect(result.data).not.toHaveProperty('toolCall');
      expect(result.data).not.toHaveProperty('toolResult');
    }
  });

  it('accepts agent_call continuing-phase shape (toolCall + toolResult required)', () => {
    // Arrange
    const input = {
      kind: 'agent_call',
      phase: 'continuing',
      index: 1,
      outerTurn: 1,
      assistantContent: 'with tool call',
      toolCall: { id: 'call_1', name: 'search', arguments: { q: 'x' } },
      toolResult: { status: 200 },
      tokensUsed: 200,
      costUsd: 0.02,
    };

    // Act
    const result = turnEntrySchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'agent_call') {
      // Narrow on phase to access continuing-only fields
      expect(result.data.phase).toBe('continuing');
      if (result.data.phase === 'continuing') {
        expect(result.data.outerTurn).toBe(1);
        expect(result.data.toolCall).toEqual({
          id: 'call_1',
          name: 'search',
          arguments: { q: 'x' },
        });
        expect(result.data.toolResult).toEqual({ status: 200 });
      }
    }
  });

  it('rejects agent_call with phase=continuing but missing toolCall (differential: same input WITH the pair parses)', () => {
    // Arrange — one-sided entry: phase claims continuing but no tool data.
    // The discriminated union must refuse this; with the old optional-fields
    // shape it would have parsed silently and corrupted resume replay.
    const baseInput = {
      kind: 'agent_call',
      phase: 'continuing',
      index: 0,
      assistantContent: 'partial',
      // toolCall + toolResult deliberately absent
      tokensUsed: 50,
      costUsd: 0.005,
    };

    // Act + Assert — failing parse without the pair
    const failing = turnEntrySchema.safeParse(baseInput);
    expect(failing.success).toBe(false);

    // Differential: adding toolCall + toolResult to the SAME input flips the
    // result to success. This pins the rejection cause specifically to the
    // missing pair — an unrelated schema regression (e.g. broken
    // `assistantContent`) would fail BOTH parses, and this test would also
    // fail on the second assertion. The two-parse pair guarantees the
    // refusal is about toolCall/toolResult, not coincidence.
    const succeeding = turnEntrySchema.safeParse({
      ...baseInput,
      toolCall: { id: 'c1', name: 'cap', arguments: {} },
      toolResult: { ok: true },
    });
    expect(succeeding.success).toBe(true);
  });

  it('strips stray toolCall on phase=terminal entries (Zod strip mode preserves the contract)', () => {
    // Arrange — terminal phase with stray toolCall. Zod's default object
    // mode is `strip`, so the unknown field is dropped rather than rejected.
    // The contract is enforced at TWO layers:
    //   1. Type layer: TS forbids constructing AgentCallTurnTerminal with toolCall.
    //   2. Parse layer: terminal schema doesn't declare toolCall, so it's stripped.
    // Under the OLD shape (single agentCallTurnSchema with optional toolCall),
    // this input would have parsed AND preserved the toolCall in the output —
    // which is exactly the data drift we're protecting against.
    const input = {
      kind: 'agent_call',
      phase: 'terminal',
      index: 0,
      assistantContent: 'final',
      toolCall: { id: 'stray', name: 'cap', arguments: {} },
      tokensUsed: 50,
      costUsd: 0.005,
    };

    // Act
    const result = turnEntrySchema.safeParse(input);

    // Assert — parse succeeds AND the parsed output drops the stray toolCall.
    // Both halves of the assertion are load-bearing: under the old schema
    // the parse would still succeed (terminal-shape input is structurally
    // valid for the old optional shape), but the output WOULD carry the
    // toolCall through. The `not.toHaveProperty` check is what distinguishes.
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'agent_call') {
      expect(result.data.phase).toBe('terminal');
      expect(result.data).not.toHaveProperty('toolCall');
    }
  });

  it('accepts orchestrator shape with minimum required fields', () => {
    // Arrange
    const input = {
      kind: 'orchestrator',
      round: 1,
      delegations: [],
      plannerTokensUsed: 50,
      plannerCostUsd: 0.005,
    };

    // Act
    const result = turnEntrySchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('orchestrator');
      if (result.data.kind === 'orchestrator') {
        expect(result.data.round).toBe(1);
        expect(result.data.delegations).toEqual([]);
      }
    }
  });

  it('accepts orchestrator shape with finalAnswer and a populated delegations array', () => {
    // Arrange
    const input = {
      kind: 'orchestrator',
      round: 2,
      finalAnswer: 'done',
      delegations: [
        {
          agentSlug: 'summariser',
          message: 'Summarise this',
          output: { text: 'Summary' },
          tokensUsed: 120,
          costUsd: 0.012,
        },
      ],
      plannerTokensUsed: 75,
      plannerCostUsd: 0.007,
    };

    // Act
    const result = turnEntrySchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'orchestrator') {
      expect(result.data.finalAnswer).toBe('done');
      expect(result.data.delegations).toHaveLength(1);
      expect(result.data.delegations[0].agentSlug).toBe('summariser');
    }
  });

  it('accepts reflect shape', () => {
    // Arrange
    const input = {
      kind: 'reflect',
      iteration: 0,
      draft: 'first',
      converged: false,
      tokensUsed: 25,
      costUsd: 0.001,
    };

    // Act
    const result = turnEntrySchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('reflect');
      if (result.data.kind === 'reflect') {
        expect(result.data.iteration).toBe(0);
        expect(result.data.converged).toBe(false);
        expect(result.data.draft).toBe('first');
      }
    }
  });

  it('rejects an unknown kind value — discriminated union produces a clear error', () => {
    // Arrange
    const input = {
      kind: 'unknown',
      index: 0,
      assistantContent: 'x',
      tokensUsed: 1,
      costUsd: 0.001,
    };

    // Act
    const result = turnEntrySchema.safeParse(input);

    // Assert: discriminated union failure
    expect(result.success).toBe(false);
    if (!result.success) {
      // The discriminator field should surface an issue
      const hasKindIssue = result.error.issues.some(
        (issue) => issue.path.includes('kind') || issue.path.length === 0
      );
      expect(hasKindIssue).toBe(true);
    }
  });

  it('accepts an empty array via turnEntriesSchema', () => {
    // Arrange + Act
    const result = turnEntriesSchema.safeParse([]);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([]);
    }
  });

  it('accepts a mixed-kind array via turnEntriesSchema', () => {
    // Arrange: array mixing reflect and agent_call
    const input = [
      {
        kind: 'reflect',
        iteration: 0,
        draft: 'v1',
        converged: false,
        tokensUsed: 10,
        costUsd: 0.001,
      },
      {
        kind: 'agent_call',
        phase: 'terminal',
        index: 0,
        assistantContent: 'ok',
        tokensUsed: 50,
        costUsd: 0.005,
      },
    ];

    // Act
    const result = turnEntriesSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].kind).toBe('reflect');
      expect(result.data[1].kind).toBe('agent_call');
    }
  });

  it('executionTraceEntrySchema accepts an entry with an optional turns field', () => {
    // Arrange: a valid trace entry that includes turns
    const input = {
      stepId: 'step-1',
      stepType: 'agent_call',
      label: 'Call Agent',
      status: 'completed',
      output: { answer: 'hello' },
      tokensUsed: 150,
      costUsd: 0.015,
      startedAt: '2024-01-01T00:00:00Z',
      durationMs: 1200,
      turns: [
        {
          kind: 'agent_call',
          phase: 'terminal',
          index: 0,
          assistantContent: 'hi',
          tokensUsed: 50,
          costUsd: 0.005,
        },
      ],
    };

    // Act
    const result = executionTraceEntrySchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(Array.isArray(data.turns)).toBe(true);
      const turns = data.turns as Array<Record<string, unknown>>;
      expect(turns).toHaveLength(1);
      expect(turns[0].kind).toBe('agent_call');
    }
  });

  it('executionTraceEntrySchema preserves the surrounding entry when turns contains a malformed element', () => {
    // Arrange: turns contains a turn with an invalid kind
    const input = {
      stepId: 'step-2',
      stepType: 'agent_call',
      label: 'Call Agent',
      status: 'completed',
      output: null,
      tokensUsed: 0,
      costUsd: 0,
      startedAt: '2024-01-01T00:00:00Z',
      durationMs: 0,
      turns: [{ kind: 'unknown' }],
    };

    // Act
    const result = executionTraceEntrySchema.safeParse(input);

    // Assert — the malformed `turns` array is gracefully dropped via `.catch()`
    // so the surrounding entry survives. Failing the whole entry would cause
    // the engine's resume `flatMap` to drop it, the stepId would not seed
    // `visited`, and the DAG walker would re-execute the already-completed
    // step. This test pins the resume-safety contract: bad `turns` must NOT
    // take the entry down with them.
    expect(result.success).toBe(true);
    if (result.success) {
      // Entry-level fields preserved
      expect((result.data as Record<string, unknown>).stepId).toBe('step-2');
      expect((result.data as Record<string, unknown>).status).toBe('completed');
      // `turns` field is absent from the parsed shape — observability lost,
      // but the step is correctly recorded as completed.
      expect((result.data as Record<string, unknown>).turns).toBeUndefined();
    }
  });

  it('executionTraceEntrySchema preserves the entry when turns contains pre-PR-3 agent_call shape (backwards-compat)', () => {
    // Arrange — this is the EXACT shape PR 2 wrote: `agent_call` turns with
    // `toolCall` / `toolResult` fields but NO `phase` discriminator. PR 3
    // made `phase` required. Without the `.catch()` on the `turns` field,
    // the entry would fail and re-execution would follow.
    //
    // This test exists specifically as a regression gate: if a future
    // refactor removes the `.catch()`, this test fails — surfacing the
    // resume-safety regression before it ships.
    const prePR3Entry = {
      stepId: 'step-multi-turn',
      stepType: 'agent_call',
      label: 'Call Agent',
      status: 'completed',
      output: { answer: 'done' },
      tokensUsed: 250,
      costUsd: 0.025,
      startedAt: '2024-01-01T00:00:00Z',
      durationMs: 2400,
      turns: [
        {
          kind: 'agent_call',
          // NO `phase` field — pre-PR-3 shape
          index: 0,
          assistantContent: 'thinking',
          toolCall: { id: 't0', name: 'cap', arguments: { q: 'x' } },
          toolResult: { ok: true },
          tokensUsed: 100,
          costUsd: 0.01,
        },
        {
          kind: 'agent_call',
          // NO `phase` field — pre-PR-3 shape
          index: 1,
          assistantContent: 'done',
          tokensUsed: 150,
          costUsd: 0.015,
        },
      ],
    };

    // Act
    const result = executionTraceEntrySchema.safeParse(prePR3Entry);

    // Assert — entry survives, stepId is preserved (so the resume engine
    // seeds `visited` correctly), turns field is dropped (catch returned
    // undefined). The cost/tokens fields at entry level still rehydrate
    // accurately because they live on the entry, not the turns sub-array.
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.stepId).toBe('step-multi-turn');
      expect(data.status).toBe('completed');
      expect(data.tokensUsed).toBe(250);
      expect(data.costUsd).toBe(0.025);
      expect(data.turns).toBeUndefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Provider model capability validation
// ────────────────────────────────────────────────────────────────────────────

describe('provider model capability validation', () => {
  function baseModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'Whisper 1',
      slug: 'openai-whisper-1',
      providerSlug: 'openai',
      modelId: 'whisper-1',
      description: 'OpenAI speech-to-text transcription model.',
      capabilities: ['audio'],
      tierRole: 'infrastructure',
      reasoningDepth: 'none',
      latency: 'fast',
      costEfficiency: 'high',
      contextLength: 'n_a',
      toolUse: 'none',
      bestRole: 'Speech-to-text',
      ...overrides,
    };
  }

  describe('createProviderModelSchema.capabilities', () => {
    it.each(['chat', 'reasoning', 'embedding', 'audio', 'image', 'moderation'] as const)(
      'accepts %s as a matrix capability',
      (capability) => {
        const result = createProviderModelSchema.safeParse(
          baseModel({ capabilities: [capability] })
        );
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.capabilities).toEqual([capability]);
        }
      }
    );

    it("rejects 'unknown' — catalogue-only placeholder", () => {
      // 'unknown' is returned by inferCapability when a model id can't
      // be classified; it must never reach the matrix.
      const result = createProviderModelSchema.safeParse(baseModel({ capabilities: ['unknown'] }));
      expect(result.success).toBe(false);
    });

    it('rejects garbage capability values', () => {
      const result = createProviderModelSchema.safeParse(
        baseModel({ capabilities: ['not-a-capability'] })
      );
      expect(result.success).toBe(false);
    });

    it('rejects empty capabilities array', () => {
      const result = createProviderModelSchema.safeParse(baseModel({ capabilities: [] }));
      expect(result.success).toBe(false);
    });

    it('accepts multi-capability rows (chat + reasoning)', () => {
      const result = createProviderModelSchema.safeParse(
        baseModel({ capabilities: ['chat', 'reasoning'] })
      );
      expect(result.success).toBe(true);
    });
  });

  describe('updateProviderModelSchema.capabilities', () => {
    it('accepts a widened capability on PATCH', () => {
      const result = updateProviderModelSchema.safeParse({ capabilities: ['reasoning'] });
      expect(result.success).toBe(true);
    });

    it("rejects 'unknown' on PATCH", () => {
      const result = updateProviderModelSchema.safeParse({ capabilities: ['unknown'] });
      expect(result.success).toBe(false);
    });

    it('rejects empty capabilities array on PATCH (when supplied)', () => {
      const result = updateProviderModelSchema.safeParse({ capabilities: [] });
      expect(result.success).toBe(false);
    });
  });

  describe('bulkCreateProviderModelsSchema.capabilities', () => {
    it('accepts a bulk row with audio capability', () => {
      const result = bulkCreateProviderModelsSchema.safeParse({
        providerSlug: 'openai',
        models: [
          {
            modelId: 'whisper-1',
            name: 'Whisper',
            capabilities: ['audio'],
            tierRole: 'infrastructure',
            reasoningDepth: 'none',
            latency: 'fast',
            costEfficiency: 'high',
            contextLength: 'n_a',
            toolUse: 'none',
            bestRole: 'Speech-to-text',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects a bulk row with 'unknown' capability", () => {
      const result = bulkCreateProviderModelsSchema.safeParse({
        providerSlug: 'openai',
        models: [
          {
            modelId: 'mystery',
            name: 'Mystery',
            capabilities: ['unknown'],
            tierRole: 'worker',
            reasoningDepth: 'none',
            latency: 'medium',
            costEfficiency: 'medium',
            contextLength: 'medium',
            toolUse: 'none',
            bestRole: '—',
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('listProviderModelsQuerySchema.capability', () => {
    it.each(['chat', 'reasoning', 'embedding', 'audio', 'image', 'moderation'] as const)(
      'accepts ?capability=%s',
      (capability) => {
        const result = listProviderModelsQuerySchema.safeParse({ capability });
        expect(result.success).toBe(true);
      }
    );

    it('rejects ?capability=unknown', () => {
      const result = listProviderModelsQuerySchema.safeParse({ capability: 'unknown' });
      expect(result.success).toBe(false);
    });
  });
});
