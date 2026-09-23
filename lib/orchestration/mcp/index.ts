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
import type { McpResourceAudience } from '@/lib/orchestration/mcp/session-manager';

// ============================================================================
// Re-exports
// ============================================================================

export { getMcpSessionManager, getMcpRateLimiter } from '@/lib/orchestration/mcp/singletons';
export type { McpResourceAudience } from '@/lib/orchestration/mcp/session-manager';
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

// ============================================================================
// Broadcast helpers — fire after admin mutations to push list_changed pings.
//
// The three `list_changed` helpers reach EVERY org's sessions, and that is
// correct rather than an oversight (§108 t-716): each announces a change to
// `McpExposedTool`, `McpExposedPrompt` or `McpExposedResource` — and
// `broadcastMcpToolsChanged` also fires on an `AiCapability` PATCH and
// soft-delete from `app/api/v1/admin/orchestration/capabilities/[id]/route.ts`,
// which is the subject the first three versions of this list forgot. All four
// are `GLOBAL_CONFIG_MODELS` (`lib/tenancy/classification.ts`). One org's admin
// enabling a tool changes what every org's `tools/list` returns, so scoping the
// ping to the editing org would leave every other org holding a stale list with
// nothing to tell them. Contrast `broadcastMcpResourceUpdated` below, whose
// audience depends on whether a definition or its contents changed.
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
 *
 * **`audience` is required and has no default** (§108 t-716). The same URI is
 * subscribed to by every org, so who is subscribed does not decide who should
 * be told: pass `'this-org'` when tenant-owned CONTENTS changed (an agent, a
 * workflow, a knowledge document — `lib/orchestration/mcp/resource-update-hooks.ts`),
 * and `'every-org'` when the resource DEFINITION changed, since
 * `McpExposedResource` is global config. Either default would be wrong for
 * half of today's callers, and wrong invisibly — a notification that does not
 * arrive looks exactly like nothing having happened. See {@link McpResourceAudience}.
 */
export function broadcastMcpResourceUpdated(uri: string, audience: McpResourceAudience): void {
  const manager = getMcpSessionManager();
  const recipients = manager.getSubscribers(uri, audience);
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
