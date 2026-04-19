/**
 * Agent Orchestration Validation Schemas
 *
 * Zod schemas for all orchestration operations including agent management,
 * capability configuration, workflow definitions, chat, knowledge base,
 * evaluation, cost tracking, and provider configuration.
 */

import { z } from 'zod';
import { paginationQuerySchema, cuidSchema, slugSchema } from '@/lib/validations/common';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { TASK_TYPES, type TaskType } from '@/types/orchestration';
import { validateTaskDefaults } from '@/lib/orchestration/llm/model-registry';

// ============================================================================
// Shared Schemas
// ============================================================================

/** Valid agent visibility values */
export const agentVisibilitySchema = z.enum(['internal', 'public', 'invite_only']);

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

  fallbackProviders: z
    .array(z.string().max(50, 'Provider slug must be less than 50 characters'))
    .max(5, 'At most 5 fallback providers')
    .default([]),

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

  rateLimitRpm: z
    .number()
    .int('Rate limit must be an integer')
    .min(1, 'Rate limit must be at least 1 RPM')
    .max(10000, 'Rate limit must be at most 10,000 RPM')
    .nullable()
    .optional(),

  inputGuardMode: z.enum(['log_only', 'warn_and_continue', 'block']).nullable().optional(),
  outputGuardMode: z.enum(['log_only', 'warn_and_continue', 'block']).nullable().optional(),
  maxHistoryTokens: z
    .number()
    .int('Max history tokens must be an integer')
    .min(1000, 'Max history tokens must be at least 1000')
    .max(2000000, 'Max history tokens must be at most 2,000,000')
    .nullable()
    .optional(),
  retentionDays: z
    .number()
    .int('Retention days must be an integer')
    .min(1, 'Retention days must be at least 1')
    .max(3650, 'Retention days must be at most 3650')
    .nullable()
    .optional(),

  visibility: agentVisibilitySchema.default('internal'),

  knowledgeCategories: z
    .array(z.string().max(100, 'Category must be less than 100 characters'))
    .max(50, 'At most 50 knowledge categories')
    .default([]),

  topicBoundaries: z.array(z.string().max(200)).max(50, 'At most 50 topic boundaries').default([]),

  brandVoiceInstructions: z
    .string()
    .max(10000, 'Brand voice instructions must be less than 10,000 characters')
    .nullable()
    .optional(),

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

  fallbackProviders: z
    .array(z.string().max(50, 'Provider slug must be less than 50 characters'))
    .max(5, 'At most 5 fallback providers')
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

  rateLimitRpm: z
    .number()
    .int('Rate limit must be an integer')
    .min(1, 'Rate limit must be at least 1 RPM')
    .max(10000, 'Rate limit must be at most 10,000 RPM')
    .nullable()
    .optional(),

  inputGuardMode: z.enum(['log_only', 'warn_and_continue', 'block']).nullable().optional(),
  outputGuardMode: z.enum(['log_only', 'warn_and_continue', 'block']).nullable().optional(),
  maxHistoryTokens: z
    .number()
    .int('Max history tokens must be an integer')
    .min(1000, 'Max history tokens must be at least 1000')
    .max(2000000, 'Max history tokens must be at most 2,000,000')
    .nullable()
    .optional(),
  retentionDays: z
    .number()
    .int('Retention days must be an integer')
    .min(1, 'Retention days must be at least 1')
    .max(3650, 'Retention days must be at most 3650')
    .nullable()
    .optional(),

  visibility: agentVisibilitySchema.optional(),

  knowledgeCategories: z
    .array(z.string().max(100))
    .max(20, 'At most 20 knowledge categories')
    .optional(),

  topicBoundaries: z.array(z.string().max(200)).max(50, 'At most 50 topic boundaries').optional(),

  brandVoiceInstructions: z
    .string()
    .max(10000, 'Brand voice instructions must be less than 10000 characters')
    .nullable()
    .optional(),

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

/**
 * Clone agent body (POST /api/v1/admin/orchestration/agents/:id/clone)
 *
 * Both fields are optional — defaults to "{source.name} (Copy)" and
 * "{source.slug}-copy".
 */
export const cloneAgentBodySchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  slug: slugSchema.pipe(z.string().max(100)).optional(),
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

  approvalTimeoutMs: z
    .number()
    .int('Approval timeout must be an integer')
    .positive('Approval timeout must be positive')
    .max(3_600_000, 'Approval timeout must be at most 1 hour')
    .nullable()
    .optional(),

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

  approvalTimeoutMs: z
    .number()
    .int('Approval timeout must be an integer')
    .positive('Approval timeout must be positive')
    .max(3_600_000, 'Approval timeout must be at most 1 hour')
    .nullable()
    .optional(),

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

/** Bulk operations on multiple agents at once. */
export const bulkAgentActionSchema = z.object({
  action: z.enum(['activate', 'deactivate', 'delete']),
  agentIds: z.array(cuidSchema).min(1, 'At least one agentId required').max(100),
});

// ============================================================================
// Webhook Schemas
// ============================================================================

export const WEBHOOK_EVENT_TYPES = [
  'budget_exceeded',
  'workflow_failed',
  'approval_required',
  'circuit_breaker_opened',
  'conversation_started',
  'conversation_completed',
  'message_created',
  'agent_updated',
  'budget_threshold_reached',
  'execution_completed',
  'execution_failed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const createWebhookSchema = z.object({
  url: z
    .string()
    .url('Must be a valid URL')
    .max(2000)
    .refine((url) => checkSafeProviderUrl(url), 'URL is not allowed (private or internal address)'),
  secret: z.string().min(16, 'Secret must be at least 16 characters').max(256),
  events: z
    .array(z.enum(WEBHOOK_EVENT_TYPES))
    .min(1, 'At least one event type is required')
    .max(WEBHOOK_EVENT_TYPES.length),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
});

export const updateWebhookSchema = z.object({
  url: z
    .string()
    .url('Must be a valid URL')
    .max(2000)
    .refine((url) => checkSafeProviderUrl(url), 'URL is not allowed (private or internal address)')
    .optional(),
  secret: z.string().min(16).max(256).optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length).optional(),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
});

export const listWebhooksQuerySchema = paginationQuerySchema.extend({
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .optional(),
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
export const workflowDefinitionSchema = z.object({
  steps: z.array(workflowStepSchema).min(1, 'Workflow must have at least one step'),
  entryStepId: z.string().min(1, 'Entry step ID is required'),
  errorStrategy: z.enum(['retry', 'fallback', 'skip', 'fail']),
});

/**
 * A single entry in `AiWorkflow.workflowDefinitionHistory`. Pushed on every
 * PATCH that actually changes `workflowDefinition`, and on every successful revert.
 */
export const workflowDefinitionHistoryEntrySchema = z.object({
  definition: z.record(z.string(), z.unknown()),
  changedAt: z.string().datetime(),
  changedBy: z.string().min(1),
});

/**
 * Runtime validator for the full `workflowDefinitionHistory` JSON column.
 * Use `safeParse` at read time — same pattern as `systemInstructionsHistorySchema`.
 */
export const workflowDefinitionHistorySchema = z.array(workflowDefinitionHistoryEntrySchema);

/**
 * Revert request — `versionIndex` is an index into the history array
 * (oldest→newest). The endpoint pushes the current definition onto
 * history before overwriting, so the forward value is never lost.
 */
export const workflowDefinitionRevertSchema = z.object({
  versionIndex: z.number().int().min(0),
});

/**
 * Dry-run body (POST /api/v1/admin/orchestration/workflows/:id/dry-run)
 */
export const dryRunWorkflowBodySchema = z.object({
  inputData: z.record(z.string(), z.unknown()),
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
/** Document scope enum — "system" for built-in patterns, "app" for user uploads */
const documentScopeSchema = z.enum(['system', 'app']);

export const knowledgeSearchSchema = z.object({
  query: z
    .string()
    .min(1, 'Search query is required')
    .max(1000, 'Search query must be less than 1000 characters')
    .trim(),

  chunkType: chunkTypeSchema.optional(),

  patternNumber: z.coerce.number().int().positive().optional(),

  category: z.string().max(100).optional(),

  scope: documentScopeSchema.optional(),

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
    .regex(
      /\.(md|txt|pdf|json|csv|html|epub|docx)$/i,
      'File must be .md, .txt, .pdf, .json, .csv, .html, .epub, or .docx'
    ),

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
const providerTypeSchema = z.enum(['anthropic', 'openai-compatible', 'voyage']);

/**
 * Provider config schema (POST /api/v1/admin/orchestration/providers)
 */
/** Workflow status enum for listExecutionsQuerySchema filters. */
const workflowStatusSchema = z.enum([
  'pending',
  'running',
  'paused_for_approval',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Shared SSRF guard applied to provider `baseUrl` values on create and
 * update. The check depends on `isLocal` — loopback targets are only
 * allowed for rows explicitly flagged `isLocal: true`. Cloud metadata,
 * RFC1918, link-local, and IPv6 unique-local ranges are rejected for
 * every row regardless of flag.
 *
 * The full allow/deny logic lives in `lib/security/safe-url.ts`; this
 * helper just adapts it to Zod's `superRefine` callback.
 */
function refineProviderBaseUrl(
  data: { baseUrl?: string | null; isLocal?: boolean },
  ctx: z.RefinementCtx
): void {
  if (!data.baseUrl) return;
  const result = checkSafeProviderUrl(data.baseUrl, { allowLoopback: data.isLocal === true });
  if (!result.ok) {
    ctx.addIssue({
      code: 'custom',
      path: ['baseUrl'],
      message: result.message ?? 'Base URL is not allowed',
    });
  }
}

export const providerConfigSchema = z
  .object({
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

    timeoutMs: z
      .number()
      .int('Timeout must be an integer')
      .min(1000, 'Timeout must be at least 1 second')
      .max(300_000, 'Timeout must be at most 5 minutes')
      .optional(),

    maxRetries: z
      .number()
      .int('Max retries must be an integer')
      .min(0, 'Max retries must be non-negative')
      .max(10, 'Max retries must be at most 10')
      .optional(),
  })
  .superRefine(refineProviderBaseUrl);

/**
 * Update provider config schema (PATCH /api/v1/admin/orchestration/providers/[id])
 *
 * All fields optional. Same env-var regex as `providerConfigSchema` so the
 * `apiKeyEnvVar` contract can never be loosened on update.
 */
export const updateProviderConfigSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Name cannot be empty')
      .max(100, 'Name must be less than 100 characters')
      .trim()
      .optional(),

    slug: slugSchema.pipe(z.string().max(50, 'Slug must be less than 50 characters')).optional(),

    providerType: providerTypeSchema.optional(),

    baseUrl: z
      .string()
      .url('Base URL must be a valid URL')
      .max(500, 'Base URL must be less than 500 characters')
      .nullable()
      .optional(),

    apiKeyEnvVar: z
      .string()
      .max(100, 'Environment variable name must be less than 100 characters')
      .regex(/^[A-Z][A-Z0-9_]*$/, 'Environment variable must be SCREAMING_SNAKE_CASE')
      .nullable()
      .optional(),

    isLocal: z.boolean().optional(),

    isActive: z.boolean().optional(),

    metadata: metadataSchema,

    timeoutMs: z
      .number()
      .int('Timeout must be an integer')
      .min(1000, 'Timeout must be at least 1 second')
      .max(300_000, 'Timeout must be at most 5 minutes')
      .nullable()
      .optional(),

    maxRetries: z
      .number()
      .int('Max retries must be an integer')
      .min(0, 'Max retries must be non-negative')
      .max(10, 'Max retries must be at most 10')
      .nullable()
      .optional(),
  })
  .superRefine(refineProviderBaseUrl);

/** List providers query schema — GET /api/v1/admin/orchestration/providers */
export const listProvidersQuerySchema = paginationQuerySchema.extend({
  isActive: z.coerce.boolean().optional(),
  providerType: providerTypeSchema.optional(),
  isLocal: z.coerce.boolean().optional(),
  q: z.string().trim().max(200).optional(),
});

/** List workflows query schema — GET /api/v1/admin/orchestration/workflows */
export const listWorkflowsQuerySchema = paginationQuerySchema.extend({
  isActive: z.coerce.boolean().optional(),
  isTemplate: z.coerce.boolean().optional(),
  q: z.string().trim().max(200).optional(),
});

/** List executions query schema — used by future engine GET endpoints. */
export const listExecutionsQuerySchema = paginationQuerySchema.extend({
  workflowId: cuidSchema.optional(),
  userId: z.string().trim().max(100).optional(),
  status: workflowStatusSchema.optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

/**
 * Execute workflow request body (POST /workflows/[id]/execute).
 *
 * Distinct from `workflowExecutionSchema` which also carries `workflowId`;
 * this schema is body-only because the route takes the workflow id from
 * the URL.
 */
export const executeWorkflowBodySchema = z.object({
  inputData: z.record(z.string(), z.unknown()),
  budgetLimitUsd: z
    .number()
    .positive('Budget limit must be positive')
    .max(1000, 'Budget limit must be at most $1,000')
    .optional(),
});

/** Approve execution request body (POST /executions/[id]/approve). */
export const approveExecutionBodySchema = z.object({
  approvalPayload: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(5000, 'Notes must be less than 5000 characters').optional(),
});

/** Retry failed step request body (POST /executions/[id]/retry-step). */
export const retryStepBodySchema = z.object({
  stepId: z.string().min(1, 'stepId is required'),
});

/**
 * Resume execution query schema (POST /workflows/[id]/execute?resumeFromExecutionId=…).
 *
 * When the engine reaches a `human_approval` step it pauses and leaves an
 * `AiWorkflowExecution` row in `paused_for_approval`. After the client
 * POSTs to `/executions/:id/approve`, it reconnects to the execute route
 * with this query parameter to stream the remaining events of the same
 * run instead of starting a new one.
 */
export const resumeExecutionQuerySchema = z.object({
  resumeFromExecutionId: cuidSchema.optional(),
});

// ============================================================================
// Session 3.3 — Chat stream, Knowledge, Conversations
// ============================================================================

/**
 * Streaming chat request body (POST /admin/orchestration/chat/stream).
 *
 * Distinct from `chatMessageSchema` which takes an `agentId` (CUID). The
 * streaming runtime takes `agentSlug` (human-readable) so the admin UI
 * can dispatch without looking up the CUID first. New schema rather
 * than mutating the existing one to avoid breaking current callers.
 */
export const chatStreamRequestSchema = z.object({
  message: z
    .string()
    .min(1, 'Message is required')
    .max(50000, 'Message must be less than 50000 characters')
    .trim(),

  agentSlug: slugSchema,

  conversationId: cuidSchema.optional(),

  contextType: z.string().max(50).optional(),

  contextId: z.string().max(100).optional(),

  entityContext: z.record(z.string().max(100), z.unknown()).optional(),
});

/** List conversations query (GET /admin/orchestration/conversations). */
export const listConversationsQuerySchema = paginationQuerySchema.extend({
  agentId: cuidSchema.optional(),
  /** Filter by user ID. When omitted, returns all users' conversations (admin audit). */
  userId: z.string().max(100).optional(),
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .optional(),
  q: z.string().trim().min(1).max(200).optional(),
  /** Full-text search across message content (case-insensitive). */
  messageSearch: z.string().trim().min(1).max(500).optional(),
  /** Filter by tag (exact match on any tag in the array). */
  tag: z.string().trim().min(1).max(100).optional(),
  /** ISO 8601 date — conversations updated on or after this date. */
  dateFrom: z.string().datetime().optional(),
  /** ISO 8601 date — conversations updated on or before this date. */
  dateTo: z.string().datetime().optional(),
});

/** Update conversation schema (PATCH /admin/orchestration/conversations/[id]). */
export const updateConversationSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20, 'At most 20 tags').optional(),
  isActive: z.boolean().optional(),
});

/** Export format for conversation export endpoint. */
export const conversationExportQuerySchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  agentId: cuidSchema.optional(),
  userId: z.string().max(100).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

/**
 * Clear conversations body (POST /admin/orchestration/conversations/clear).
 *
 * At least one filter must be supplied — an empty body is rejected to
 * prevent accidental "delete all my conversations" calls. `userId` is
 * never an input; the route hardcodes `session.user.id`.
 */
export const clearConversationsBodySchema = z
  .object({
    olderThan: z.string().datetime({ offset: true }).optional(),
    agentId: cuidSchema.optional(),
  })
  .refine((v) => v.olderThan !== undefined || v.agentId !== undefined, {
    message: 'At least one of `olderThan` or `agentId` must be provided',
  });

/** List knowledge documents query (GET /admin/orchestration/knowledge/documents). */
export const listDocumentsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['pending', 'processing', 'ready', 'failed', 'pending_review']).optional(),
  scope: documentScopeSchema.optional(),
  category: z.string().max(100).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

/**
 * Pattern URL parameter (GET /admin/orchestration/knowledge/patterns/[number]).
 * Coerces from the string path param to a positive integer.
 */
export const getPatternParamSchema = z.object({
  number: z.coerce
    .number()
    .int('Pattern number must be an integer')
    .positive('Pattern number must be positive'),
});

// ============================================================================
// Session 3.4 — Costs & Evaluations
// ============================================================================

/** Maximum span for a cost breakdown query — one year. Prevents unbounded scans. */
const COST_BREAKDOWN_MAX_SPAN_DAYS = 366;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Cost breakdown query (GET /admin/orchestration/costs).
 *
 * Requires an explicit date range and `groupBy` axis. The range is
 * capped at ~1 year to prevent unbounded `AiCostLog` scans.
 */
export const costBreakdownQuerySchema = z
  .object({
    agentId: cuidSchema.optional(),
    dateFrom: z.coerce.date({ message: 'dateFrom is required and must be a valid date' }),
    dateTo: z.coerce.date({ message: 'dateTo is required and must be a valid date' }),
    groupBy: z.enum(['day', 'agent', 'model']),
  })
  .refine((v) => v.dateTo.getTime() >= v.dateFrom.getTime(), {
    message: 'dateTo must be on or after dateFrom',
    path: ['dateTo'],
  })
  .refine(
    (v) => v.dateTo.getTime() - v.dateFrom.getTime() <= COST_BREAKDOWN_MAX_SPAN_DAYS * MS_PER_DAY,
    {
      message: `Date range must be at most ${COST_BREAKDOWN_MAX_SPAN_DAYS} days`,
      path: ['dateTo'],
    }
  );

/** List evaluations query (GET /admin/orchestration/evaluations). */
export const listEvaluationsQuerySchema = paginationQuerySchema.extend({
  agentId: cuidSchema.optional(),
  status: evaluationStatusSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

/**
 * Create evaluation session body (POST /admin/orchestration/evaluations).
 *
 * Narrower than `evaluationSessionSchema` — new sessions always start
 * as `draft`; status transitions happen via PATCH / the `/complete`
 * endpoint.
 */
export const createEvaluationSchema = z.object({
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

  metadata: metadataSchema,
});

/**
 * Update evaluation session body (PATCH /admin/orchestration/evaluations/:id).
 *
 * Cannot set `status: 'completed'` — completion goes through the
 * `/complete` endpoint so the AI analysis and status flip are atomic.
 * At least one field must be present (empty body rejected).
 */
export const updateEvaluationSchema = z
  .object({
    title: z
      .string()
      .min(1, 'Title is required')
      .max(200, 'Title must be less than 200 characters')
      .trim()
      .optional(),
    description: z
      .string()
      .max(5000, 'Description must be less than 5000 characters')
      .trim()
      .optional(),
    status: z.enum(['draft', 'in_progress', 'archived']).optional(),
    metadata: metadataSchema,
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.status !== undefined ||
      v.metadata !== undefined,
    { message: 'At least one field must be provided' }
  );

/**
 * Evaluation logs query (GET /admin/orchestration/evaluations/:id/logs).
 *
 * Cursor pagination: pass `before` (a positive integer `sequenceNumber`)
 * to return only rows with a strictly smaller sequence number. Results
 * are always returned in ascending `sequenceNumber` order, so this
 * cursor matches the display order exactly — no CUID lexicographic-vs-
 * numeric-order divergence.
 */
export const evaluationLogsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
});

/**
 * Complete evaluation body (POST /admin/orchestration/evaluations/:id/complete).
 *
 * Empty object today; kept as a schema so the route can call
 * `validateRequestBody` consistently and so future options (e.g.
 * `{ model?: string }`) land without breaking the route signature.
 */
export const completeEvaluationBodySchema = z.object({}).passthrough();

// ============================================================================
// Orchestration Settings (Phase 4 Session 4.4)
// ============================================================================

/**
 * Partial update for the singleton `AiOrchestrationSettings` row.
 *
 * Only the fields that appear on the request body are touched on the row.
 * `defaultModels` is partial-patchable — the server merges with the
 * existing map so admins can change a single task at a time.
 *
 * `.superRefine` delegates to `validateTaskDefaults()` in the model
 * registry so unknown model ids are rejected at the boundary.
 */
/**
 * Runtime validator for the `defaultModels` JSON column read from
 * `AiOrchestrationSettings`. Parses a `Prisma.JsonValue` into a
 * `Record<string, string>` so the route handler can merge stored values into
 * the computed defaults without a blind `as` cast. Unknown shapes (null,
 * array, primitives) collapse to `{}` at the call site via `.catch({})`.
 */
export const storedDefaultModelsSchema = z.record(z.string(), z.string()).catch({});

/** Zod schema for hybrid search weight configuration. */
export const searchConfigSchema = z.object({
  keywordBoostWeight: z
    .number()
    .min(-0.2, 'Keyword boost must be at least -0.2')
    .max(0, 'Keyword boost must be non-positive (it reduces cosine distance for matches)'),
  vectorWeight: z
    .number()
    .min(0.1, 'Vector weight must be at least 0.1')
    .max(2.0, 'Vector weight must be at most 2.0'),
});

export const updateOrchestrationSettingsSchema = z
  .object({
    defaultModels: z
      .record(z.enum(TASK_TYPES), z.string().min(1).max(200))
      .optional()
      .superRefine((val, ctx) => {
        if (!val) return;
        const errors = validateTaskDefaults(val as Partial<Record<TaskType, string>>);
        for (const err of errors) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['defaultModels', err.task],
            message: err.message,
          });
        }
      }),
    globalMonthlyBudgetUsd: z
      .number()
      .nonnegative('Global monthly budget must be zero or positive')
      .max(1_000_000, 'Global monthly budget must be at most $1,000,000')
      .nullable()
      .optional(),
    searchConfig: searchConfigSchema.nullable().optional(),
    defaultApprovalTimeoutMs: z
      .number()
      .int()
      .positive('Approval timeout must be positive')
      .max(3_600_000, 'Approval timeout must be at most 1 hour')
      .nullable()
      .optional(),
    approvalDefaultAction: z.enum(['deny', 'allow']).nullable().optional(),
    inputGuardMode: z.enum(['log_only', 'warn_and_continue', 'block']).nullable().optional(),
  })
  .refine(
    (v) =>
      v.defaultModels !== undefined ||
      v.globalMonthlyBudgetUsd !== undefined ||
      v.searchConfig !== undefined ||
      v.defaultApprovalTimeoutMs !== undefined ||
      v.approvalDefaultAction !== undefined ||
      v.inputGuardMode !== undefined,
    {
      message: 'At least one field must be provided',
    }
  );

// ============================================================================
// Execution Trace — Prisma Json column parsing
// ============================================================================

/**
 * Schema for `AiWorkflowExecution.executionTrace` entries stored as Prisma
 * `Json`. Used in route handlers to safely parse the raw JSON array instead
 * of blind-casting.
 */
export const executionTraceEntrySchema = z.object({
  stepId: z.string(),
  stepType: z.string(),
  label: z.string(),
  status: z.enum(['completed', 'failed', 'skipped', 'awaiting_approval']),
  output: z.unknown(),
  error: z.string().optional(),
  tokensUsed: z.number(),
  costUsd: z.number(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number(),
});

export const executionTraceSchema = z.array(executionTraceEntrySchema).catch([]);

// ============================================================================
// Executor Config Schemas — step.config validation
// ============================================================================

/** Shared error-strategy fields present on every step config. */
export const stepErrorConfigSchema = z.object({
  errorStrategy: z.enum(['retry', 'fallback', 'skip', 'fail']).optional(),
  retryCount: z.number().int().nonnegative().optional(),
  fallbackStepId: z.string().optional(),
  /** Per-step execution timeout in milliseconds. When exceeded, the step
   *  fails with code 'step_timeout'. The error strategy still applies. */
  timeoutMs: z.number().int().positive().optional(),
});

/** Structured output format for LLM calls. */
export const llmResponseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    name: z.string(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }),
]);

export const llmCallConfigSchema = stepErrorConfigSchema.extend({
  prompt: z.string().optional(),
  modelOverride: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  responseFormat: llmResponseFormatSchema.optional(),
});

export const toolCallConfigSchema = stepErrorConfigSchema.extend({
  capabilitySlug: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const routeConfigSchema = stepErrorConfigSchema.extend({
  classificationPrompt: z.string().optional(),
  routes: z.array(z.object({ label: z.unknown() })).optional(),
  modelOverride: z.string().optional(),
  temperature: z.number().optional(),
});

export const reflectConfigSchema = stepErrorConfigSchema.extend({
  critiquePrompt: z.string().optional(),
  maxIterations: z.number().optional(),
  modelOverride: z.string().optional(),
  temperature: z.number().optional(),
});

export const planConfigSchema = stepErrorConfigSchema.extend({
  objective: z.string().optional(),
  maxSubSteps: z.number().optional(),
  modelOverride: z.string().optional(),
  temperature: z.number().optional(),
});

export const humanApprovalConfigSchema = stepErrorConfigSchema.extend({
  prompt: z.string().optional(),
  timeoutMinutes: z.number().optional(),
  notificationChannel: z.string().optional(),
});

export const ragRetrieveConfigSchema = stepErrorConfigSchema.extend({
  query: z.string().optional(),
  topK: z.number().optional(),
  similarityThreshold: z.number().optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
});

export const guardConfigSchema = stepErrorConfigSchema.extend({
  rules: z.string().optional(),
  mode: z.enum(['llm', 'regex']).optional(),
  failAction: z.enum(['block', 'flag']).optional(),
  modelOverride: z.string().optional(),
  temperature: z.number().optional(),
});

export const evaluateConfigSchema = stepErrorConfigSchema.extend({
  rubric: z.string().optional(),
  scaleMin: z.number().optional(),
  scaleMax: z.number().optional(),
  threshold: z.number().optional(),
  modelOverride: z.string().optional(),
  temperature: z.number().optional(),
});

/** Response transformation config for external-call steps. */
export const responseTransformSchema = z.object({
  /** Transformation type. `jmespath` for structured extraction. `template` for string templates. */
  type: z.enum(['jmespath', 'template']),
  /** JMESPath expression or Handlebars-style template string. */
  expression: z.string().min(1).max(2000),
});

export const externalCallConfigSchema = stepErrorConfigSchema.extend({
  url: z.string().optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyTemplate: z.string().optional(),
  timeoutMs: z.number().optional(),
  authType: z.enum(['none', 'bearer', 'api-key', 'query-param']).optional(),
  authSecret: z.string().optional(),
  /** Name of the query parameter when authType is 'query-param' (default: 'api_key'). */
  authQueryParam: z.string().optional(),
  /** Max response body size in bytes (default: 1 048 576 = 1 MB). */
  maxResponseBytes: z.number().int().positive().optional(),
  /** Optional transformation to apply to the response body before returning step output. */
  responseTransform: responseTransformSchema.optional(),
});

export const agentCallConfigSchema = stepErrorConfigSchema.extend({
  agentSlug: z.string().optional(),
  message: z.string().optional(),
  maxToolIterations: z.number().int().min(0).max(20).optional(),
  /** 'single-turn' (default) — one prompt/response. 'multi-turn' — back-and-forth with maxTurns. */
  mode: z.enum(['single-turn', 'multi-turn']).optional(),
  /** Max conversation turns in multi-turn mode (default 3, max 10). */
  maxTurns: z.number().int().min(1).max(10).optional(),
});

// ---------- Workflow Schedule ─────────────────────────────────────────────

export const createScheduleSchema = z.object({
  name: z.string().min(1).max(200),
  cronExpression: z.string().min(1).max(100),
  inputTemplate: z.record(z.string(), z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
});

export const updateScheduleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cronExpression: z.string().min(1).max(100).optional(),
  inputTemplate: z.record(z.string(), z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
});

// ---------- Analytics Query ─────────────────────────────────────────────────

/** Shared date-range + agent filter for analytics endpoints */
export const analyticsQuerySchema = z.object({
  /** ISO date string — start of range (inclusive). Defaults to 30 days ago. */
  from: z.string().datetime().optional(),
  /** ISO date string — end of range (inclusive). Defaults to now. */
  to: z.string().datetime().optional(),
  /** Filter to a specific agent by ID. */
  agentId: cuidSchema.optional(),
  /** Max results to return (default 20, max 100). */
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ---------- Message Rating ──────────────────────────────────────────────────

/** Thumbs up/down rating for assistant messages */
export const rateMessageSchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
});

// ---------- Agent Invite Tokens ----------

/** Create an invite token for an invite_only agent */
export const createInviteTokenSchema = z.object({
  label: z.string().max(200).optional(),
  maxUses: z.number().int().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

// ---------- API Keys ----------

/** Create a new API key */
export const createApiKeySchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  scopes: z
    .array(z.enum(['chat', 'analytics', 'knowledge', 'webhook', 'admin']))
    .min(1, 'At least one scope is required')
    .default(['chat']),
  expiresAt: z.string().datetime().optional(),
});

// ---------- Message Metadata (Prisma JSON rehydration) ----------

export const messageMetadataSchema = z.object({
  tokenUsage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
  modelUsed: z.string().optional(),
  latencyMs: z.number().optional(),
  costUsd: z.number().optional(),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type CloneAgentBody = z.infer<typeof cloneAgentBodySchema>;
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
export type WorkflowDefinitionHistoryEntry = z.infer<typeof workflowDefinitionHistoryEntrySchema>;
export type WorkflowDefinitionRevertInput = z.infer<typeof workflowDefinitionRevertSchema>;
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type WorkflowExecutionInput = z.infer<typeof workflowExecutionSchema>;
export type EvaluationSessionInput = z.infer<typeof evaluationSessionSchema>;
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchSchema>;
/** Supported document formats and their MIME types. */
export const SUPPORTED_DOCUMENT_FORMATS = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.epub': 'application/epub+zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
} as const;

/** Max document size: 50 MB. */
export const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Confirm a previewed document for chunking + embedding.
 * Used after the preview step for PDF uploads.
 */
export const confirmDocumentPreviewSchema = z.object({
  /** The document ID created during the preview step. */
  documentId: cuidSchema,
  /** Optionally supply edited/corrected text to replace the parsed content. */
  correctedContent: z.string().max(5_000_000, 'Content must be less than 5 MB').optional(),
  /** Optional category override. */
  category: z.string().max(100).optional(),
});

export type ConfirmDocumentPreviewInput = z.infer<typeof confirmDocumentPreviewSchema>;
export type DocumentUploadInput = z.infer<typeof documentUploadSchema>;
export type CostQueryInput = z.infer<typeof costQuerySchema>;
export type ProviderConfigInput = z.infer<typeof providerConfigSchema>;
export type UpdateProviderConfigInput = z.infer<typeof updateProviderConfigSchema>;
export type ListProvidersQuery = z.infer<typeof listProvidersQuerySchema>;
export type ListWorkflowsQuery = z.infer<typeof listWorkflowsQuerySchema>;
export type ListExecutionsQuery = z.infer<typeof listExecutionsQuerySchema>;
export type ExecuteWorkflowBodyInput = z.infer<typeof executeWorkflowBodySchema>;
export type ApproveExecutionBodyInput = z.infer<typeof approveExecutionBodySchema>;
export type ResumeExecutionQueryInput = z.infer<typeof resumeExecutionQuerySchema>;
export type ChatStreamRequestInput = z.infer<typeof chatStreamRequestSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type ConversationExportQuery = z.infer<typeof conversationExportQuerySchema>;
export type ClearConversationsBodyInput = z.infer<typeof clearConversationsBodySchema>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
export type GetPatternParamInput = z.infer<typeof getPatternParamSchema>;
export type CostBreakdownQuery = z.infer<typeof costBreakdownQuerySchema>;
export type ListEvaluationsQuery = z.infer<typeof listEvaluationsQuerySchema>;
export type CreateEvaluationInput = z.infer<typeof createEvaluationSchema>;
export type UpdateEvaluationInput = z.infer<typeof updateEvaluationSchema>;
export type EvaluationLogsQuery = z.infer<typeof evaluationLogsQuerySchema>;
export type CompleteEvaluationBodyInput = z.infer<typeof completeEvaluationBodySchema>;
export type UpdateOrchestrationSettingsInput = z.infer<typeof updateOrchestrationSettingsSchema>;

// ---------------------------------------------------------------------------
// Consumer chat (non-admin) schemas
// ---------------------------------------------------------------------------

/**
 * Consumer chat request schema (POST /api/v1/chat/stream).
 * Simpler than admin — no contextType/contextId/entityContext.
 */
/** Attachment validation for multimodal chat messages. */
export const chatAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mediaType: z.enum([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
  data: z.string().min(1), // base64-encoded content
});

export const consumerChatRequestSchema = z.object({
  message: z
    .string()
    .min(1, 'Message is required')
    .max(50000, 'Message must be less than 50000 characters')
    .trim(),

  agentSlug: slugSchema,

  conversationId: cuidSchema.optional(),

  /** Invite token for accessing invite_only agents */
  inviteToken: z.string().optional(),

  /** File attachments (images, documents) — max 10 per message. */
  attachments: z.array(chatAttachmentSchema).max(10).optional(),
});

/** Consumer conversations list query (GET /api/v1/chat/conversations). */
export const consumerConversationsQuerySchema = paginationQuerySchema.extend({
  agentSlug: slugSchema.optional(),
});

export type ConsumerChatRequestInput = z.infer<typeof consumerChatRequestSchema>;
export type ConsumerConversationsQuery = z.infer<typeof consumerConversationsQuerySchema>;
export type AgentVisibility = z.infer<typeof agentVisibilitySchema>;

// ---------------------------------------------------------------------------
// Quiz scores
// ---------------------------------------------------------------------------

/** POST body for saving a quiz score. */
export const saveQuizScoreSchema = z
  .object({
    correct: z.number().int().min(0),
    total: z.number().int().min(1),
  })
  .refine((d) => d.correct <= d.total, {
    message: 'correct must be ≤ total',
    path: ['correct'],
  });

export type SaveQuizScoreInput = z.infer<typeof saveQuizScoreSchema>;
