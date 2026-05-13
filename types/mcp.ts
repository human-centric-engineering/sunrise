/**
 * MCP Server Types
 *
 * TypeScript types for the MCP (Model Context Protocol) server layer
 * including JSON-RPC 2.0 messages, MCP protocol types, and admin API shapes.
 */

import type {
  McpServerConfig,
  McpExposedTool,
  McpExposedResource,
  McpApiKey,
  McpAuditLog,
  AiCapability,
} from '@/types/prisma';

// ============================================================================
// JSON-RPC 2.0
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC 2.0 error codes + application-level codes */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Application-level: authentication failed (invalid or missing API key) */
  UNAUTHORIZED: -32001,
  /** Application-level: session not found or expired */
  SESSION_NOT_FOUND: -32002,
  /** Application-level: MCP server is disabled */
  SERVER_DISABLED: -32003,
} as const;
export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

// ============================================================================
// MCP Protocol
// ============================================================================

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: Record<string, never>;
  resources?: Record<string, never>;
  prompts?: Record<string, never>;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
  serverInfo: McpServerInfo;
}

export interface McpToolDefinition {
  /** Internal capability slug (not sent to MCP clients) */
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpContentBlock {
  type: 'text';
  text: string;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: McpContentBlock;
}

// ============================================================================
// MCP Scopes
// ============================================================================

export const McpScope = {
  TOOLS_LIST: 'tools:list',
  TOOLS_EXECUTE: 'tools:execute',
  RESOURCES_READ: 'resources:read',
  PROMPTS_READ: 'prompts:read',
} as const;
export type McpScope = (typeof McpScope)[keyof typeof McpScope];

export const ALL_MCP_SCOPES: McpScope[] = Object.values(McpScope);

// ============================================================================
// MCP Resource Types
// ============================================================================

export const McpResourceType = {
  KNOWLEDGE_SEARCH: 'knowledge_search',
  AGENT_LIST: 'agent_list',
  PATTERN_DETAIL: 'pattern_detail',
  WORKFLOW_LIST: 'workflow_list',
} as const;
export type McpResourceType = (typeof McpResourceType)[keyof typeof McpResourceType];

// ============================================================================
// MCP Session
// ============================================================================

export interface McpSession {
  id: string;
  apiKeyId: string;
  initialized: boolean;
  createdAt: number;
  lastActivityAt: number;
}

// ============================================================================
// MCP Auth Context
// ============================================================================

export interface McpAuthContext {
  apiKeyId: string;
  apiKeyName: string;
  scopes: string[];
  createdBy: string;
  clientIp: string;
  userAgent: string;
  /**
   * When set, the API key is bound to a specific agent and MCP resources/tools that
   * touch the knowledge base should resolve via that agent's grants (see
   * `lib/orchestration/knowledge/resolveAgentDocumentAccess`). When null, the key is
   * an explicit "unscoped service key" with system-wide access — audited as such.
   */
  scopedAgentId: string | null;
}

// ============================================================================
// Admin API Shapes
// ============================================================================

export type McpServerConfigRow = McpServerConfig;
export type McpExposedToolRow = McpExposedTool;
export type McpExposedResourceRow = McpExposedResource;
export type McpApiKeyRow = McpApiKey;
export type McpAuditLogRow = McpAuditLog;

/** Exposed tool with joined capability data */
export interface McpExposedToolWithCapability extends McpExposedTool {
  capability: AiCapability;
}

/** API key creation result — plaintext returned once */
export interface McpApiKeyCreateResult {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  plaintext: string;
}
