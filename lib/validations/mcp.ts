/**
 * MCP Server Validation Schemas
 *
 * Zod schemas for all MCP server operations including settings management,
 * tool exposure, resource configuration, API key management, and audit queries.
 */

import { z } from 'zod';
import { paginationQuerySchema, cuidSchema } from '@/lib/validations/common';
import { McpScope, ALL_MCP_SCOPES, McpResourceType } from '@/types/mcp';

// ============================================================================
// Shared
// ============================================================================

/** MCP tool name: lowercase letters, digits, underscores, starting with a letter */
const mcpToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Tool name must start with a lowercase letter and contain only lowercase letters, digits, and underscores'
  );

const mcpScopeSchema = z.enum([
  McpScope.TOOLS_LIST,
  McpScope.TOOLS_EXECUTE,
  McpScope.RESOURCES_READ,
  McpScope.PROMPTS_READ,
]);

// ============================================================================
// MCP Server Config (Singleton Settings)
// ============================================================================

/**
 * Update MCP server config (PATCH /api/v1/admin/orchestration/mcp/settings)
 */
export const updateMcpSettingsSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    serverName: z.string().min(1).max(100).trim().optional(),
    serverVersion: z.string().min(1).max(20).trim().optional(),
    maxSessionsPerKey: z.number().int().min(1).max(100).optional(),
    globalRateLimit: z.number().int().min(1).max(10000).optional(),
    auditRetentionDays: z.number().int().min(0).max(3650).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateMcpSettings = z.infer<typeof updateMcpSettingsSchema>;

// ============================================================================
// Exposed Tools
// ============================================================================

/**
 * Create exposed tool (POST /api/v1/admin/orchestration/mcp/tools)
 */
export const createExposedToolSchema = z.object({
  capabilityId: cuidSchema,
  isEnabled: z.boolean().default(false),
  customName: mcpToolNameSchema.nullable().optional(),
  customDescription: z.string().max(5000).trim().nullable().optional(),
  rateLimitPerKey: z.number().int().min(1).max(10000).nullable().optional(),
  requiresScope: z.string().max(100).nullable().optional(),
});

export type CreateExposedTool = z.infer<typeof createExposedToolSchema>;

/**
 * Update exposed tool (PATCH /api/v1/admin/orchestration/mcp/tools/:id)
 */
export const updateExposedToolSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    customName: mcpToolNameSchema.nullable().optional(),
    customDescription: z.string().max(5000).trim().nullable().optional(),
    rateLimitPerKey: z.number().int().min(1).max(10000).nullable().optional(),
    requiresScope: z.string().max(100).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateExposedTool = z.infer<typeof updateExposedToolSchema>;

/**
 * List exposed tools query (GET /api/v1/admin/orchestration/mcp/tools)
 */
export const listExposedToolsQuerySchema = z.object({
  ...paginationQuerySchema.shape,
  isEnabled: z.coerce.boolean().optional(),
});

export type ListExposedToolsQuery = z.infer<typeof listExposedToolsQuerySchema>;

// ============================================================================
// Exposed Resources
// ============================================================================

const resourceTypeSchema = z.enum([
  McpResourceType.KNOWLEDGE_SEARCH,
  McpResourceType.AGENT_LIST,
  McpResourceType.PATTERN_DETAIL,
  McpResourceType.WORKFLOW_LIST,
]);

/**
 * Create exposed resource (POST /api/v1/admin/orchestration/mcp/resources)
 */
export const createExposedResourceSchema = z.object({
  uri: z
    .string()
    .min(1)
    .max(500)
    .regex(/^sunrise:\/\//, 'URI must use the sunrise:// scheme'),
  name: z.string().min(1).max(100).trim(),
  description: z.string().min(1).max(5000).trim(),
  mimeType: z.string().min(1).max(100).default('application/json'),
  resourceType: resourceTypeSchema,
  isEnabled: z.boolean().default(false),
  handlerConfig: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type CreateExposedResource = z.infer<typeof createExposedResourceSchema>;

/**
 * Update exposed resource (PATCH /api/v1/admin/orchestration/mcp/resources/:id)
 */
export const updateExposedResourceSchema = z
  .object({
    name: z.string().min(1).max(100).trim().optional(),
    description: z.string().min(1).max(5000).trim().optional(),
    mimeType: z.string().min(1).max(100).optional(),
    isEnabled: z.boolean().optional(),
    handlerConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateExposedResource = z.infer<typeof updateExposedResourceSchema>;

/**
 * List exposed resources query (GET /api/v1/admin/orchestration/mcp/resources)
 */
export const listExposedResourcesQuerySchema = z.object({
  ...paginationQuerySchema.shape,
  isEnabled: z.coerce.boolean().optional(),
  resourceType: resourceTypeSchema.optional(),
});

export type ListExposedResourcesQuery = z.infer<typeof listExposedResourcesQuerySchema>;

// ============================================================================
// API Keys
// ============================================================================

/**
 * Create MCP API key (POST /api/v1/admin/orchestration/mcp/keys)
 */
export const createApiKeySchema = z.object({
  name: z.string().min(1).max(100).trim(),
  scopes: z
    .array(mcpScopeSchema)
    .min(1, 'At least one scope is required')
    .refine((arr) => new Set(arr).size === arr.length, 'Duplicate scopes are not allowed'),
  expiresAt: z.coerce
    .date()
    .min(new Date(), 'Expiration must be in the future')
    .nullable()
    .optional(),
  rateLimitOverride: z.number().int().min(1).max(10000).nullable().optional(),
});

export type CreateApiKey = z.infer<typeof createApiKeySchema>;

/**
 * Update MCP API key (PATCH /api/v1/admin/orchestration/mcp/keys/:id)
 */
export const updateApiKeySchema = z
  .object({
    name: z.string().min(1).max(100).trim().optional(),
    isActive: z.boolean().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    rateLimitOverride: z.number().int().min(1).max(10000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateApiKey = z.infer<typeof updateApiKeySchema>;

/**
 * Rotate MCP API key (POST /api/v1/admin/orchestration/mcp/keys/:id/rotate)
 *
 * Generates new key material. The plaintext is returned once and never stored.
 * Optionally update the key's expiry at rotation time.
 */
export const mcpApiKeyRotateSchema = z.object({
  expiresAt: z.coerce
    .date()
    .refine((d) => d > new Date(), { message: 'expiresAt must be in the future' })
    .nullable()
    .optional(),
});

export type McpApiKeyRotate = z.infer<typeof mcpApiKeyRotateSchema>;

/**
 * List API keys query (GET /api/v1/admin/orchestration/mcp/keys)
 */
export const listApiKeysQuerySchema = z.object({
  ...paginationQuerySchema.shape,
  isActive: z.coerce.boolean().optional(),
});

export type ListApiKeysQuery = z.infer<typeof listApiKeysQuerySchema>;

// ============================================================================
// Audit Log
// ============================================================================

/**
 * Query audit logs (GET /api/v1/admin/orchestration/mcp/audit)
 */
export const mcpAuditQuerySchema = z.object({
  ...paginationQuerySchema.shape,
  method: z.string().max(50).optional(),
  toolSlug: z.string().max(100).optional(),
  apiKeyId: cuidSchema.optional(),
  responseCode: z.enum(['success', 'error', 'rate_limited']).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export type McpAuditQuery = z.infer<typeof mcpAuditQuerySchema>;

// ============================================================================
// JSON-RPC Validation
// ============================================================================

/**
 * Validate incoming JSON-RPC 2.0 request envelope.
 * This validates the structure only — method-specific params are
 * validated by individual handlers.
 */
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1).max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Validate MCP tools/call params
 */
export const mcpToolCallParamsSchema = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Validate MCP resources/read params
 */
export const mcpResourceReadParamsSchema = z.object({
  uri: z.string().min(1).max(500),
});

/**
 * Validate MCP prompts/get params
 */
export const mcpPromptGetParamsSchema = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// Admin UI Response Schemas
// ============================================================================

/** MCP settings response — used by mcp-dashboard */
export const mcpSettingsResponseSchema = z.object({
  isEnabled: z.boolean(),
  serverName: z.string(),
  serverVersion: z.string(),
  maxSessionsPerKey: z.number(),
  globalRateLimit: z.number(),
  auditRetentionDays: z.number(),
});
export type McpSettingsResponse = z.infer<typeof mcpSettingsResponseSchema>;

/** Exposed resource row — used by mcp-resources-list */
export const resourceRowSchema = z.object({
  id: z.string(),
  uri: z.string(),
  name: z.string(),
  description: z.string(),
  mimeType: z.string(),
  resourceType: z.string(),
  isEnabled: z.boolean(),
});
export type ResourceRow = z.infer<typeof resourceRowSchema>;

/** Exposed tool with joined capability — used by mcp-tools-list */
export const exposedToolRowSchema = z.object({
  id: z.string(),
  capabilityId: z.string(),
  isEnabled: z.boolean(),
  customName: z.string().nullable(),
  customDescription: z.string().nullable(),
  rateLimitPerKey: z.number().nullable(),
  requiresScope: z.string().nullable(),
  capability: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string(),
    category: z.string(),
  }),
});
export type ExposedToolRow = z.infer<typeof exposedToolRowSchema>;

/** API key row — used by mcp-keys-list */
export const apiKeyRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  isActive: z.boolean(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  rateLimitOverride: z.number().nullable(),
  createdAt: z.string(),
  creator: z.object({ name: z.string(), email: z.string() }),
});
export type ApiKeyRow = z.infer<typeof apiKeyRowSchema>;

/** Audit log entry — used by mcp-audit-log */
export const auditEntrySchema = z.object({
  id: z.string(),
  method: z.string(),
  toolSlug: z.string().nullable(),
  resourceUri: z.string().nullable(),
  responseCode: z.string(),
  errorMessage: z.string().nullable(),
  durationMs: z.number(),
  clientIp: z.string().nullable(),
  createdAt: z.string(),
  apiKey: z.object({ name: z.string(), keyPrefix: z.string() }).nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});
export type AuditMeta = z.infer<typeof auditMetaSchema>;

// ============================================================================
// Exported constants
// ============================================================================

export { ALL_MCP_SCOPES };
