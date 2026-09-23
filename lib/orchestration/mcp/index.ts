/**
 * MCP Server Module
 *
 * Re-exports for the MCP server layer. Singletons live in `./singletons`
 * so leaf modules can grab them without dragging the barrel into a
 * circular import.
 *
 * Platform-agnostic: no Next.js imports.
 */

// ============================================================================
// Re-exports
// ============================================================================

export { getMcpSessionManager, getMcpRateLimiter } from '@/lib/orchestration/mcp/singletons';
export { handleMcpRequest, McpProtocolError } from '@/lib/orchestration/mcp/protocol-handler';
export { getMcpServerConfig, invalidateMcpConfigCache } from '@/lib/orchestration/mcp/config';
export { authenticateMcpRequest, generateApiKey, hashApiKey } from '@/lib/orchestration/mcp/auth';
export { logMcpAudit, queryMcpAuditLogs } from '@/lib/orchestration/mcp/audit-logger';
export {
  listMcpTools,
  callMcpTool,
  clearMcpToolCache,
} from '@/lib/orchestration/mcp/tool-registry';
export {
  listMcpResources,
  readMcpResource,
  listMcpResourceTemplates,
  clearMcpResourceCache,
  isRegisteredMcpResourceUri,
  // Fork seam (#563) — app-owned resource types + URI schemes.
  registerMcpResourceHandler,
  isDispatchableMcpResourceType,
  isAllowedMcpResourceUri,
  isUriSchemeValidForResourceType,
  mcpResourceUriSchemeFor,
  listAppMcpResourceTypes,
  listAllowedMcpResourceUriSchemes,
  type AppMcpResourceRegistration,
} from '@/lib/orchestration/mcp/resource-registry';
export {
  listMcpPrompts,
  getMcpPrompt,
  clearMcpPromptCache,
  MAX_ENABLED_PROMPTS,
} from '@/lib/orchestration/mcp/prompt-registry';
