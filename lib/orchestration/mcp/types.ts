/**
 * MCP Server Internal Types
 *
 * Internal types used within the MCP module. Public protocol types
 * live in `types/mcp.ts` — this file holds implementation-specific
 * shapes that should not leak outside the module.
 *
 * Platform-agnostic: no Next.js imports.
 */

/** Result of MCP server config lookup */
export interface McpServerState {
  isEnabled: boolean;
  serverName: string;
  serverVersion: string;
  globalRateLimit: number;
  auditRetentionDays: number;
}
