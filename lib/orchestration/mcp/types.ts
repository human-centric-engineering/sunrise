/**
 * MCP Server Internal Types
 *
 * Internal types used within the MCP module. Public protocol types
 * live in `types/mcp.ts` — this file holds implementation-specific
 * shapes that should not leak outside the module.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { McpAuthContext, McpSession } from '@/types/mcp';

/** Handler function signature for MCP JSON-RPC methods */
export type McpMethodHandler = (
  params: Record<string, unknown> | undefined,
  context: McpRequestContext
) => Promise<unknown>;

/** Context passed to every MCP method handler */
export interface McpRequestContext {
  auth: McpAuthContext;
  session: McpSession;
}

/** Result of MCP server config lookup */
export interface McpServerState {
  isEnabled: boolean;
  serverName: string;
  serverVersion: string;
  maxSessionsPerKey: number;
  globalRateLimit: number;
  auditRetentionDays: number;
}
