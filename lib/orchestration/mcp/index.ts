/**
 * MCP Server Module
 *
 * Re-exports for the MCP server layer. Singletons live in `./singletons`
 * so leaf modules can grab them without dragging the barrel into a
 * circular import.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { getMcpSessionManager } from '@/lib/orchestration/mcp/singletons';

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
} from '@/lib/orchestration/mcp/resource-registry';
export {
  listMcpPrompts,
  getMcpPrompt,
  clearMcpPromptCache,
  MAX_ENABLED_PROMPTS,
} from '@/lib/orchestration/mcp/prompt-registry';

// ============================================================================
// Broadcast helpers — fire after admin mutations to push list_changed pings.
// ============================================================================

export function broadcastMcpToolsChanged(): void {
  getMcpSessionManager().broadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
  });
}

export function broadcastMcpResourcesChanged(): void {
  getMcpSessionManager().broadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/resources/list_changed',
  });
}

export function broadcastMcpPromptsChanged(): void {
  getMcpSessionManager().broadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/prompts/list_changed',
  });
}

/**
 * Push `notifications/resources/updated` to every session subscribed to the
 * given URI. Called from:
 *   - the admin `PATCH /resources/[id]` route (resource row changed)
 *   - knowledge ingestion completion (re-embedded docs invalidate
 *     `sunrise://knowledge/search`)
 *   - agent / workflow CRUD (mutate `sunrise://agents` /
 *     `sunrise://workflows`)
 *
 * No-op when nobody is subscribed, so callers can fire this freely.
 */
export function broadcastMcpResourceUpdated(uri: string): void {
  const manager = getMcpSessionManager();
  const recipients = manager.getSubscribers(uri);
  if (recipients.length === 0) return;
  manager.broadcastNotification(
    {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri },
    },
    recipients
  );
}
