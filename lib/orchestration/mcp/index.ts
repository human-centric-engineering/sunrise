/**
 * MCP Server Module
 *
 * Re-exports for the MCP server layer. Provides singleton access
 * to the session manager and convenience exports for protocol handling.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { McpSessionManager } from '@/lib/orchestration/mcp/session-manager';
import { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';

// ============================================================================
// Singletons
// ============================================================================

let sessionManager: McpSessionManager | null = null;
let rateLimiter: McpRateLimiter | null = null;

export function getMcpSessionManager(): McpSessionManager {
  if (!sessionManager) {
    sessionManager = new McpSessionManager();
  }
  return sessionManager;
}

export function getMcpRateLimiter(): McpRateLimiter {
  if (!rateLimiter) {
    rateLimiter = new McpRateLimiter();
  }
  return rateLimiter;
}

// ============================================================================
// Re-exports
// ============================================================================

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
} from '@/lib/orchestration/mcp/resource-registry';
export { listMcpPrompts, getMcpPrompt } from '@/lib/orchestration/mcp/prompt-registry';

/**
 * Broadcast tool/resource list change notifications to all connected SSE clients.
 * Call this after admin mutations to tool/resource exposure.
 */
export function broadcastMcpToolsChanged(): void {
  const manager = getMcpSessionManager();
  manager.broadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
  });
}

export function broadcastMcpResourcesChanged(): void {
  const manager = getMcpSessionManager();
  manager.broadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/resources/list_changed',
  });
}
