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
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  workflowDefinitionHistoryEntrySchema,
  workflowDefinitionHistorySchema,
  workflowDefinitionRevertSchema,
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
      type: 'agent',
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
    expect(result.success).toBe(true);
  });

  it('should apply defaults: provider=anthropic, temperature=0.7, maxTokens=4096, isActive=true', () => {
    const result = createAgentSchema.safeParse(VALID_AGENT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('anthropic');
      expect(result.data.temperature).toBe(0.7);
      expect(result.data.maxTokens).toBe(4096);
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
    expect(result.success).toBe(true);
  });

  it('should accept a partial update with only name', () => {
    const result = updateAgentSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('should accept monthlyBudgetUsd: null to clear the budget', () => {
    const result = updateAgentSchema.safeParse({ monthlyBudgetUsd: null });
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
    expect(result.success).toBe(true);
  });

  it('should default requiresApproval=false and isActive=true', () => {
    const result = createCapabilitySchema.safeParse(VALID_CAPABILITY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiresApproval).toBe(false);
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
    expect(result.success).toBe(true);
  });

  it('should accept rateLimit: null to clear the rate limit', () => {
    const result = updateCapabilitySchema.safeParse({ rateLimit: null });
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
    expect(result.success).toBe(true);
  });

  it('should default patternsUsed=[], isActive=true, isTemplate=false', () => {
    const result = createWorkflowSchema.safeParse(VALID_WORKFLOW);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patternsUsed).toEqual([]);
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
    expect(result.success).toBe(true);
  });

  it('should accept a partial update with only isTemplate', () => {
    const result = updateWorkflowSchema.safeParse({ isTemplate: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isTemplate).toBe(true);
    }
  });

  it('should reject empty description', () => {
    const result = updateWorkflowSchema.safeParse({ description: '' });
    expect(result.success).toBe(false);
  });

  it('should accept "skip" as a valid errorStrategy in workflowDefinition update', () => {
    const result = updateWorkflowSchema.safeParse({
      workflowDefinition: { ...VALID_WORKFLOW_DEF, errorStrategy: 'skip' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject unknown errorStrategy values in workflowDefinition update', () => {
    const result = updateWorkflowSchema.safeParse({
      workflowDefinition: { ...VALID_WORKFLOW_DEF, errorStrategy: 'explode' },
    });
    expect(result.success).toBe(false);
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
// workflowDefinitionHistoryEntrySchema
// ────────────────────────────────────────────────────────────────────────────

describe('workflowDefinitionHistoryEntrySchema', () => {
  const VALID_ENTRY = {
    definition: { steps: [], entryStepId: 'step-1', errorStrategy: 'fail' },
    changedAt: '2025-06-01T00:00:00.000Z',
    changedBy: 'cmjbv4i3x00003wsloputgwul',
  };

  it('accepts a valid history entry', () => {
    const result = workflowDefinitionHistoryEntrySchema.safeParse(VALID_ENTRY);
    expect(result.success).toBe(true);
  });

  it('rejects when definition is missing', () => {
    const { definition: _def, ...rest } = VALID_ENTRY;
    const result = workflowDefinitionHistoryEntrySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when changedAt is not a datetime string', () => {
    const result = workflowDefinitionHistoryEntrySchema.safeParse({
      ...VALID_ENTRY,
      changedAt: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when changedBy is empty', () => {
    const result = workflowDefinitionHistoryEntrySchema.safeParse({
      ...VALID_ENTRY,
      changedBy: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when changedBy is missing', () => {
    const { changedBy: _cb, ...rest } = VALID_ENTRY;
    const result = workflowDefinitionHistoryEntrySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// workflowDefinitionHistorySchema
// ────────────────────────────────────────────────────────────────────────────

describe('workflowDefinitionHistorySchema', () => {
  const VALID_ENTRY = {
    definition: { steps: [] },
    changedAt: '2025-06-01T00:00:00.000Z',
    changedBy: 'user-abc',
  };

  it('accepts an empty array', () => {
    const result = workflowDefinitionHistorySchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it('accepts an array of valid entries', () => {
    const result = workflowDefinitionHistorySchema.safeParse([VALID_ENTRY, VALID_ENTRY]);
    expect(result.success).toBe(true);
  });

  it('rejects when any entry has a missing changedAt', () => {
    const bad = { definition: {}, changedBy: 'user-abc' };
    const result = workflowDefinitionHistorySchema.safeParse([VALID_ENTRY, bad]);
    expect(result.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// workflowDefinitionRevertSchema
// ────────────────────────────────────────────────────────────────────────────

describe('workflowDefinitionRevertSchema', () => {
  it('accepts versionIndex of 0', () => {
    const result = workflowDefinitionRevertSchema.safeParse({ versionIndex: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts a positive integer versionIndex', () => {
    const result = workflowDefinitionRevertSchema.safeParse({ versionIndex: 5 });
    expect(result.success).toBe(true);
  });

  it('rejects a negative versionIndex', () => {
    const result = workflowDefinitionRevertSchema.safeParse({ versionIndex: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer versionIndex', () => {
    const result = workflowDefinitionRevertSchema.safeParse({ versionIndex: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects when versionIndex is missing', () => {
    const result = workflowDefinitionRevertSchema.safeParse({});
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
    expect(result.success).toBe(true);
  });

  it('should accept optional conversationId, contextType, contextId', () => {
    const result = chatMessageSchema.safeParse({
      ...VALID_MESSAGE,
      conversationId: 'conv-123',
      contextType: 'document',
      contextId: 'doc-456',
    });
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
    expect(result.success).toBe(true);
  });

  it('should accept an optional budgetLimitUsd', () => {
    const result = workflowExecutionSchema.safeParse({ ...VALID_EXECUTION, budgetLimitUsd: 5.0 });
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
    expect(result.success).toBe(true);
  });

  it('should default status to draft', () => {
    const result = evaluationSessionSchema.safeParse(VALID_SESSION);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('draft');
    }
  });

  it('should accept all valid status values', () => {
    const statuses = ['draft', 'in_progress', 'completed', 'archived'] as const;
    for (const status of statuses) {
      const result = evaluationSessionSchema.safeParse({ ...VALID_SESSION, status });
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
    expect(result.success).toBe(true);
  });

  it('should default limit to 10', () => {
    const result = knowledgeSearchSchema.safeParse({ query: 'retry pattern' });
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
    expect(result.success).toBe(true);
  });

  it('should accept all whitelisted file extensions', () => {
    const extensions = ['md', 'txt', 'pdf', 'json', 'csv', 'html'];
    for (const ext of extensions) {
      const result = documentUploadSchema.safeParse({
        ...VALID_DOCUMENT,
        fileName: `file.${ext}`,
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject a disallowed file extension', () => {
    const result = documentUploadSchema.safeParse({ ...VALID_DOCUMENT, fileName: 'doc.docx' });
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
    expect(result.success).toBe(true);
  });

  it('should coerce date strings to Date objects', () => {
    const result = costQuerySchema.safeParse(VALID_COST_QUERY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.startDate).toBeInstanceOf(Date);
      expect(result.data.endDate).toBeInstanceOf(Date);
    }
  });

  it('should accept an optional agentId as CUID', () => {
    const result = costQuerySchema.safeParse({ ...VALID_COST_QUERY, agentId: VALID_CUID });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe(VALID_CUID);
    }
  });

  it('should accept all valid operation values', () => {
    const operations = ['chat', 'tool_call', 'embedding', 'evaluation'] as const;
    for (const operation of operations) {
      const result = costQuerySchema.safeParse({ ...VALID_COST_QUERY, operation });
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
    expect(result.success).toBe(true);
  });

  it('should default isLocal=false and isActive=true', () => {
    const result = providerConfigSchema.safeParse(VALID_PROVIDER);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isLocal).toBe(false);
      expect(result.data.isActive).toBe(true);
    }
  });

  it('should accept both valid providerType values', () => {
    const types = ['anthropic', 'openai-compatible'] as const;
    for (const providerType of types) {
      const result = providerConfigSchema.safeParse({ ...VALID_PROVIDER, providerType });
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
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBeGreaterThanOrEqual(1);
      expect(result.data.limit).toBeGreaterThan(0);
    }
  });

  it('should coerce isActive string to boolean', () => {
    const result = listAgentsQuerySchema.safeParse({ isActive: 'true', provider: 'anthropic' });
    expect(result.success).toBe(true);
    if (result.success) {
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
    expect(result.success).toBe(true);
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
  it('should accept an empty object', () => {
    expect(updateAgentCapabilitySchema.safeParse({}).success).toBe(true);
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
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.conflictMode).toBe('skip');
  });

  it('should accept conflictMode overwrite', () => {
    const result = importAgentsSchema.safeParse({
      bundle: MINIMAL_BUNDLE,
      conflictMode: 'overwrite',
    });
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
    expect(result.success).toBe(true);
  });

  it('accepts nullable apiKeyEnvVar and baseUrl', () => {
    const result = updateProviderConfigSchema.safeParse({
      apiKeyEnvVar: null,
      baseUrl: null,
    });
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
    expect(result.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// listProvidersQuerySchema
// ────────────────────────────────────────────────────────────────────────────

describe('listProvidersQuerySchema', () => {
  it('accepts an empty query (pagination defaults)', () => {
    const result = listProvidersQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('coerces isActive string to boolean and accepts providerType', () => {
    const result = listProvidersQuerySchema.safeParse({
      isActive: 'true',
      providerType: 'anthropic',
      q: 'claude',
    });
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
    expect(result.success).toBe(true);
  });

  it('accepts inputData with a positive budgetLimitUsd', () => {
    const result = executeWorkflowBodySchema.safeParse({
      inputData: {},
      budgetLimitUsd: 5.5,
    });
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
    expect(result.success).toBe(true);
  });

  it('accepts an approvalPayload and notes', () => {
    const result = approveExecutionBodySchema.safeParse({
      approvalPayload: { decision: 'approved' },
      notes: 'Looks good',
    });
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
});

describe('listConversationsQuerySchema', () => {
  it('accepts pagination defaults and no filters', () => {
    const result = listConversationsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('coerces string "true" / "false" into boolean for isActive', () => {
    const result = listConversationsQuerySchema.safeParse({ isActive: 'true' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.isActive).toBe(true);
  });

  it('accepts q substring filter', () => {
    const result = listConversationsQuerySchema.safeParse({ q: 'test search' });
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
    expect(result.success).toBe(true);
  });

  it('accepts an agentId alone', () => {
    const result = clearConversationsBodySchema.safeParse({
      agentId: 'clh1234567890abcdefghijkl',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid ISO datetime', () => {
    const result = clearConversationsBodySchema.safeParse({ olderThan: 'yesterday' });
    expect(result.success).toBe(false);
  });
});

describe('listDocumentsQuerySchema', () => {
  it('accepts the default pagination with no filters', () => {
    const result = listDocumentsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a valid status enum value', () => {
    const result = listDocumentsQuerySchema.safeParse({ status: 'ready' });
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
    expect(result.success).toBe(true);
  });

  it('accepts an optional agentId filter', () => {
    const result = costBreakdownQuerySchema.safeParse({
      agentId: VALID_CUID,
      dateFrom: '2026-01-01',
      dateTo: '2026-01-02',
      groupBy: 'model',
    });
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
    expect(result.success).toBe(true);
  });

  it('accepts agentId + status + q filters', () => {
    const result = listEvaluationsQuerySchema.safeParse({
      agentId: VALID_CUID,
      status: 'in_progress',
      q: 'retention',
    });
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
    expect(result.success).toBe(true);
  });

  it('accepts a status transition to in_progress', () => {
    const result = updateEvaluationSchema.safeParse({ status: 'in_progress' });
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
    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(100);
  });

  it('coerces a numeric string limit', () => {
    const result = evaluationLogsQuerySchema.safeParse({ limit: '25' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(25);
  });

  it('rejects a limit above 500', () => {
    const result = evaluationLogsQuerySchema.safeParse({ limit: '501' });
    expect(result.success).toBe(false);
  });

  it('accepts an optional before cursor (positive integer sequenceNumber)', () => {
    const result = evaluationLogsQuerySchema.safeParse({ before: 42 });
    expect(result.success).toBe(true);
    expect(result.success && result.data.before).toBe(42);
  });

  it('coerces a numeric-string before cursor', () => {
    const result = evaluationLogsQuerySchema.safeParse({ before: '7' });
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
    expect(result.success).toBe(true);
  });

  it('accepts unknown extra fields (passthrough for forward compat)', () => {
    const result = completeEvaluationBodySchema.safeParse({ futureOption: true });
    expect(result.success).toBe(true);
  });
});
