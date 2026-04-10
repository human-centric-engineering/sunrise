/**
 * Agent Orchestration Validation Schemas
 *
 * Zod schemas for all orchestration operations including agent management,
 * capability configuration, workflow definitions, chat, knowledge base,
 * evaluation, cost tracking, and provider configuration.
 */

import { z } from 'zod';
import { paginationQuerySchema, cuidSchema, slugSchema } from './common';

// ============================================================================
// Shared Schemas
// ============================================================================

/** Reusable metadata schema — safe primitive values only */
const metadataSchema = z
  .record(z.string().max(100), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]))
  .refine((obj) => Object.keys(obj).length <= 100, {
    message: 'Metadata cannot have more than 100 keys',
  })
  .optional();

/**
 * Runtime validator for `AiCapability.functionDefinition` JSON column reads.
 * Used by the capability dispatcher / registry to parse the Prisma `Json`
 * value into a trusted `CapabilityFunctionDefinition` rather than
 * blind-casting. Malformed rows are logged and skipped at the call site.
 */
export const capabilityFunctionDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

// ============================================================================
// Agent Schemas
// ============================================================================

/**
 * Create agent schema (POST /api/v1/admin/orchestration/agents)
 */
export const createAgentSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .trim(),

  slug: slugSchema.pipe(z.string().max(100, 'Slug must be less than 100 characters')),

  description: z
    .string()
    .min(1, 'Description is required')
    .max(5000, 'Description must be less than 5000 characters')
    .trim(),

  systemInstructions: z
    .string()
    .min(1, 'System instructions are required')
    .max(50000, 'System instructions must be less than 50000 characters'),

  model: z.string().min(1, 'Model is required').max(100, 'Model must be less than 100 characters'),

  provider: z
    .string()
    .min(1, 'Provider is required')
    .max(50, 'Provider must be less than 50 characters')
    .default('anthropic'),

  providerConfig: z.record(z.string(), z.unknown()).optional(),

  temperature: z
    .number()
    .min(0, 'Temperature must be at least 0')
    .max(2, 'Temperature must be at most 2')
    .default(0.7),

  maxTokens: z
    .number()
    .int('Max tokens must be an integer')
    .min(1, 'Max tokens must be at least 1')
    .max(200000, 'Max tokens must be at most 200000')
    .default(4096),

  monthlyBudgetUsd: z
    .number()
    .positive('Monthly budget must be positive')
    .max(10000, 'Monthly budget must be at most $10,000')
    .optional(),

  metadata: metadataSchema,

  isActive: z.boolean().default(true),
});

/**
 * Update agent schema (PATCH /api/v1/admin/orchestration/agents/[id])
 */
export const updateAgentSchema = z.object({
  name: z
    .string()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name must be less than 100 characters')
    .trim()
    .optional(),

  slug: slugSchema.pipe(z.string().max(100, 'Slug must be less than 100 characters')).optional(),

  description: z
    .string()
    .min(1, 'Description cannot be empty')
    .max(5000, 'Description must be less than 5000 characters')
    .trim()
    .optional(),

  systemInstructions: z
    .string()
    .min(1, 'System instructions cannot be empty')
    .max(50000, 'System instructions must be less than 50000 characters')
    .optional(),

  model: z
    .string()
    .min(1, 'Model cannot be empty')
    .max(100, 'Model must be less than 100 characters')
    .optional(),

  provider: z
    .string()
    .min(1, 'Provider cannot be empty')
    .max(50, 'Provider must be less than 50 characters')
    .optional(),

  providerConfig: z.record(z.string(), z.unknown()).optional(),

  temperature: z
    .number()
    .min(0, 'Temperature must be at least 0')
    .max(2, 'Temperature must be at most 2')
    .optional(),

  maxTokens: z
    .number()
    .int('Max tokens must be an integer')
    .min(1, 'Max tokens must be at least 1')
    .max(200000, 'Max tokens must be at most 200000')
    .optional(),

  monthlyBudgetUsd: z
    .number()
    .positive('Monthly budget must be positive')
    .max(10000, 'Monthly budget must be at most $10,000')
    .nullable()
    .optional(),

  metadata: metadataSchema,

  isActive: z.boolean().optional(),
});

/**
 * List agents query schema — GET /api/v1/admin/orchestration/agents
 * Pagination + filters. `q` searches name/slug/description.
 */
export const listAgentsQuerySchema = paginationQuerySchema.extend({
  isActive: z.coerce.boolean().optional(),
  provider: z.string().trim().max(50).optional(),
  q: z.string().trim().max(200).optional(),
});

/**
 * A single entry in `AiAgent.systemInstructionsHistory`. Pushed on every PATCH
 * that actually changes `systemInstructions`, and on every successful revert.
 */
export const systemInstructionsHistoryEntrySchema = z.object({
  instructions: z.string().min(1),
  changedAt: z.string().datetime(),
  changedBy: z.string().min(1),
});

/**
 * Runtime validator for the full `systemInstructionsHistory` JSON column.
 * Use `safeParse` at read time (same warn-and-skip pattern we use for
 * `capabilityFunctionDefinitionSchema`) so a malformed row can't crash
 * the admin routes.
 */
export const systemInstructionsHistorySchema = z.array(systemInstructionsHistoryEntrySchema);

/**
 * Revert request — `versionIndex` is an index into the history array
 * (oldest = 0, newest = length - 1). The route pushes the *current*
 * instructions onto history before overwriting them, so the forward
 * value is never lost.
 */
export const instructionsRevertSchema = z.object({
  versionIndex: z.number().int().min(0),
});

// ============================================================================
// Capability Schemas
// ============================================================================

/** Execution type enum */
const executionTypeSchema = z.enum(['internal', 'api', 'webhook']);

/**
 * Create capability schema (POST /api/v1/admin/orchestration/capabilities)
 */
export const createCapabilitySchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .trim(),

  slug: slugSchema.pipe(z.string().max(100, 'Slug must be less than 100 characters')),

  description: z
    .string()
    .min(1, 'Description is required')
    .max(5000, 'Description must be less than 5000 characters')
    .trim(),

  category: z
    .string()
    .min(1, 'Category is required')
    .max(50, 'Category must be less than 50 characters')
    .trim(),

  functionDefinition: z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),

  executionType: executionTypeSchema,

  executionHandler: z
    .string()
    .min(1, 'Execution handler is required')
    .max(500, 'Execution handler must be less than 500 characters'),

  executionConfig: z.record(z.string(), z.unknown()).optional(),

  requiresApproval: z.boolean().default(false),

  rateLimit: z
    .number()
    .int('Rate limit must be an integer')
    .min(1, 'Rate limit must be at least 1')
    .max(10000, 'Rate limit must be at most 10000')
    .optional(),

  isActive: z.boolean().default(true),

  metadata: metadataSchema,
});

/**
 * Update capability schema (PATCH /api/v1/admin/orchestration/capabilities/[id])
 */
export const updateCapabilitySchema = z.object({
  name: z
    .string()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name must be less than 100 characters')
    .trim()
    .optional(),

  slug: slugSchema.pipe(z.string().max(100, 'Slug must be less than 100 characters')).optional(),

  description: z
    .string()
    .min(1, 'Description cannot be empty')
    .max(5000, 'Description must be less than 5000 characters')
    .trim()
    .optional(),

  category: z
    .string()
    .min(1, 'Category cannot be empty')
    .max(50, 'Category must be less than 50 characters')
    .trim()
    .optional(),

  functionDefinition: z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional(),

  executionType: executionTypeSchema.optional(),

  executionHandler: z
    .string()
    .min(1, 'Execution handler cannot be empty')
    .max(500, 'Execution handler must be less than 500 characters')
    .optional(),

  executionConfig: z.record(z.string(), z.unknown()).optional(),

  requiresApproval: z.boolean().optional(),

  rateLimit: z
    .number()
    .int('Rate limit must be an integer')
    .min(1, 'Rate limit must be at least 1')
    .max(10000, 'Rate limit must be at most 10000')
    .nullable()
    .optional(),

  isActive: z.boolean().optional(),

  metadata: metadataSchema,
});

/**
 * List capabilities query schema — GET /api/v1/admin/orchestration/capabilities
 */
export const listCapabilitiesQuerySchema = paginationQuerySchema.extend({
  isActive: z.coerce.boolean().optional(),
  category: z.string().trim().max(50).optional(),
  executionType: executionTypeSchema.optional(),
  q: z.string().trim().max(200).optional(),
});

// ============================================================================
// Agent → Capability Pivot Schemas
// ============================================================================

/**
 * Attach a capability to an agent — POST /agents/[id]/capabilities
 * The `capabilityId` identifies the `AiCapability` row to link. The pivot
 * row (`AiAgentCapability`) is keyed by the compound `(agentId, capabilityId)`.
 */
export const attachAgentCapabilitySchema = z.object({
  capabilityId: cuidSchema,
  isEnabled: z.boolean().default(true),
  customConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  customRateLimit: z
    .number()
    .int('Custom rate limit must be an integer')
    .min(1, 'Custom rate limit must be at least 1')
    .max(10000, 'Custom rate limit must be at most 10000')
    .nullable()
    .optional(),
});

/**
 * Update an agent↔capability link — PATCH /agents/[id]/capabilities/[capId]
 * All fields optional. The pivot is identified by the URL params, not the body.
 */
export const updateAgentCapabilitySchema = z.object({
  isEnabled: z.boolean().optional(),
  customConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  customRateLimit: z
    .number()
    .int('Custom rate limit must be an integer')
    .min(1, 'Custom rate limit must be at least 1')
    .max(10000, 'Custom rate limit must be at most 10000')
    .nullable()
    .optional(),
});

// ============================================================================
// Agent Export / Import Schemas
// ============================================================================

/**
 * Export request — POST /agents/export
 * Bulk-exports the selected agents into a versioned bundle suitable for
 * version control or migrating between environments.
 */
export const exportAgentsSchema = z.object({
  agentIds: z.array(cuidSchema).min(1, 'At least one agentId required').max(100),
});

/**
 * One agent inside an export bundle. Strips server-owned fields
 * (`id`, `createdAt`, `updatedAt`, `createdBy`) and embeds attached
 * capabilities by slug so the bundle is portable across environments.
 */
const bundledAgentSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100),
  description: z.string().min(1).max(5000),
  systemInstructions: z.string().min(1).max(50000),
  systemInstructionsHistory: systemInstructionsHistorySchema.default([]),
  model: z.string().min(1).max(100),
  provider: z.string().min(1).max(50),
  providerConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(200000),
  monthlyBudgetUsd: z.number().positive().max(10000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  isActive: z.boolean(),
  capabilities: z
    .array(
      z.object({
        slug: z.string().min(1).max(100),
        isEnabled: z.boolean().default(true),
        customConfig: z.record(z.string(), z.unknown()).nullable().optional(),
        customRateLimit: z.number().int().min(1).max(10000).nullable().optional(),
      })
    )
    .default([]),
});

/**
 * Full export bundle shape. Both the export route (produces) and the
 * import route (consumes) reference this schema, so round-tripping is
 * type-safe.
 */
export const agentBundleSchema = z.object({
  version: z.literal('1'),
  exportedAt: z.string().datetime(),
  agents: z.array(bundledAgentSchema).min(1).max(100),
});

/**
 * Import request — POST /agents/import
 * `conflictMode` defaults to `skip` so re-importing an existing bundle
 * can't accidentally overwrite production data. Callers must explicitly
 * opt-in to `overwrite`.
 */
export const importAgentsSchema = z.object({
  bundle: agentBundleSchema,
  conflictMode: z.enum(['skip', 'overwrite']).default('skip'),
});

// ============================================================================
// Workflow Schemas
// ============================================================================

/** Conditional edge within a workflow DAG */
const conditionalEdgeSchema = z.object({
  targetStepId: z.string().min(1, 'Target step ID is required'),
  condition: z.string().max(1000).optional(),
});

/** Single workflow step */
const workflowStepSchema = z.object({
  id: z.string().min(1, 'Step ID is required'),
  name: z.string().min(1, 'Step name is required').max(100),
  type: z.string().min(1, 'Step type is required').max(50),
  config: z.record(z.string(), z.unknown()),
  nextSteps: z.array(conditionalEdgeSchema).default([]),
});

/** Complete workflow definition */
const workflowDefinitionSchema = z.object({
  steps: z.array(workflowStepSchema).min(1, 'Workflow must have at least one step'),
  entryStepId: z.string().min(1, 'Entry step ID is required'),
  errorStrategy: z.enum(['retry', 'fallback', 'fail']),
});

/**
 * Create workflow schema (POST /api/v1/admin/orchestration/workflows)
 */
export const createWorkflowSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .trim(),

  slug: slugSchema.pipe(z.string().max(100, 'Slug must be less than 100 characters')),

  description: z
    .string()
    .min(1, 'Description is required')
    .max(5000, 'Description must be less than 5000 characters')
    .trim(),

  workflowDefinition: workflowDefinitionSchema,

  patternsUsed: z.array(z.number().int().positive('Pattern number must be positive')).default([]),

  isActive: z.boolean().default(true),

  isTemplate: z.boolean().default(false),

  metadata: metadataSchema,
});

/**
 * Update workflow schema (PATCH /api/v1/admin/orchestration/workflows/[id])
 */
export const updateWorkflowSchema = z.object({
  name: z
    .string()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name must be less than 100 characters')
    .trim()
    .optional(),

  slug: slugSchema.pipe(z.string().max(100, 'Slug must be less than 100 characters')).optional(),

  description: z
    .string()
    .min(1, 'Description cannot be empty')
    .max(5000, 'Description must be less than 5000 characters')
    .trim()
    .optional(),

  workflowDefinition: workflowDefinitionSchema.optional(),

  patternsUsed: z.array(z.number().int().positive('Pattern number must be positive')).optional(),

  isActive: z.boolean().optional(),

  isTemplate: z.boolean().optional(),

  metadata: metadataSchema,
});

// ============================================================================
// Chat Schemas
// ============================================================================

/**
 * Chat message input schema (POST /api/v1/admin/orchestration/chat)
 */
export const chatMessageSchema = z.object({
  agentId: cuidSchema,

  conversationId: z.string().optional(),

  message: z
    .string()
    .min(1, 'Message is required')
    .max(50000, 'Message must be less than 50000 characters')
    .trim(),

  contextType: z.string().max(50).optional(),

  contextId: z.string().max(100).optional(),
});

// ============================================================================
// Workflow Execution Schemas
// ============================================================================

/**
 * Start workflow execution schema (POST /api/v1/admin/orchestration/workflows/[id]/execute)
 */
export const workflowExecutionSchema = z.object({
  workflowId: cuidSchema,

  inputData: z.record(z.string(), z.unknown()),

  budgetLimitUsd: z
    .number()
    .positive('Budget limit must be positive')
    .max(1000, 'Budget limit must be at most $1,000')
    .optional(),
});

// ============================================================================
// Evaluation Schemas
// ============================================================================

/** Evaluation status enum */
const evaluationStatusSchema = z.enum(['draft', 'in_progress', 'completed', 'archived']);

/**
 * Create evaluation session schema (POST /api/v1/admin/orchestration/evaluations)
 */
export const evaluationSessionSchema = z.object({
  agentId: cuidSchema,

  title: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be less than 200 characters')
    .trim(),

  description: z
    .string()
    .max(5000, 'Description must be less than 5000 characters')
    .trim()
    .optional(),

  status: evaluationStatusSchema.default('draft'),

  metadata: metadataSchema,
});

// ============================================================================
// Knowledge Base Schemas
// ============================================================================

/** Chunk type enum */
const chunkTypeSchema = z.enum([
  'pattern_section',
  'pattern_overview',
  'glossary',
  'composition_recipe',
  'selection_guide',
  'cost_reference',
  'context_engineering',
  'emerging_concepts',
  'ecosystem',
]);

/**
 * Knowledge search schema (GET /api/v1/admin/orchestration/knowledge/search)
 */
export const knowledgeSearchSchema = z.object({
  query: z
    .string()
    .min(1, 'Search query is required')
    .max(1000, 'Search query must be less than 1000 characters')
    .trim(),

  chunkType: chunkTypeSchema.optional(),

  patternNumber: z.coerce.number().int().positive().optional(),

  category: z.string().max(100).optional(),

  limit: z.coerce
    .number()
    .int('Limit must be an integer')
    .positive('Limit must be positive')
    .max(50, 'Maximum limit is 50')
    .default(10),
});

/**
 * Document upload schema (POST /api/v1/admin/orchestration/knowledge/documents)
 */
export const documentUploadSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(200, 'Name must be less than 200 characters')
    .trim(),

  fileName: z
    .string()
    .min(1, 'File name is required')
    .max(500, 'File name must be less than 500 characters')
    .regex(/\.(md|txt|pdf|json|csv|html)$/i, 'File must be .md, .txt, .pdf, .json, .csv, or .html'),

  fileHash: z
    .string()
    .min(64, 'File hash must be a SHA-256 hex string')
    .max(64, 'File hash must be a SHA-256 hex string')
    .regex(/^[a-f0-9]{64}$/, 'File hash must be a valid SHA-256 hex string'),
});

// ============================================================================
// Cost Tracking Schemas
// ============================================================================

/** Cost operation enum */
const costOperationSchema = z.enum(['chat', 'tool_call', 'embedding', 'evaluation']);

/**
 * Cost query schema (GET /api/v1/admin/orchestration/costs)
 */
export const costQuerySchema = z.object({
  startDate: z.coerce.date({ message: 'Start date is required' }),

  endDate: z.coerce.date({ message: 'End date is required' }),

  agentId: cuidSchema.optional(),

  provider: z.string().max(50).optional(),

  operation: costOperationSchema.optional(),

  ...paginationQuerySchema.shape,
});

// ============================================================================
// Provider Config Schemas
// ============================================================================

/** Provider type enum */
const providerTypeSchema = z.enum(['anthropic', 'openai-compatible']);

/**
 * Provider config schema (POST /api/v1/admin/orchestration/providers)
 */
export const providerConfigSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .trim(),

  slug: slugSchema.pipe(z.string().max(50, 'Slug must be less than 50 characters')),

  providerType: providerTypeSchema,

  baseUrl: z
    .string()
    .url('Base URL must be a valid URL')
    .max(500, 'Base URL must be less than 500 characters')
    .optional(),

  apiKeyEnvVar: z
    .string()
    .max(100, 'Environment variable name must be less than 100 characters')
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Environment variable must be SCREAMING_SNAKE_CASE')
    .optional(),

  isLocal: z.boolean().default(false),

  isActive: z.boolean().default(true),

  metadata: metadataSchema,
});

// ============================================================================
// Inferred Types
// ============================================================================

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
export type SystemInstructionsHistoryEntry = z.infer<typeof systemInstructionsHistoryEntrySchema>;
export type InstructionsRevertInput = z.infer<typeof instructionsRevertSchema>;
export type CreateCapabilityInput = z.infer<typeof createCapabilitySchema>;
export type UpdateCapabilityInput = z.infer<typeof updateCapabilitySchema>;
export type ListCapabilitiesQuery = z.infer<typeof listCapabilitiesQuerySchema>;
export type AttachAgentCapabilityInput = z.infer<typeof attachAgentCapabilitySchema>;
export type UpdateAgentCapabilityInput = z.infer<typeof updateAgentCapabilitySchema>;
export type ExportAgentsInput = z.infer<typeof exportAgentsSchema>;
export type AgentBundle = z.infer<typeof agentBundleSchema>;
export type ImportAgentsInput = z.infer<typeof importAgentsSchema>;
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
export type WorkflowExecutionInput = z.infer<typeof workflowExecutionSchema>;
export type EvaluationSessionInput = z.infer<typeof evaluationSessionSchema>;
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchSchema>;
export type DocumentUploadInput = z.infer<typeof documentUploadSchema>;
export type CostQueryInput = z.infer<typeof costQuerySchema>;
export type ProviderConfigInput = z.infer<typeof providerConfigSchema>;
