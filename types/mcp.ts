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
  /** Application-level: per-key or global rate limit exceeded — client should back off and retry */
  RATE_LIMITED: -32004,
} as const;
export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

// ============================================================================
// MCP Protocol
// ============================================================================

/**
 * Supported MCP protocol versions, newest first. The server negotiates the
 * highest version it shares with the client during `initialize`. New entries
 * go at the front; deprecated entries fall off the back when no client we
 * care about uses them.
 */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export const MCP_LATEST_PROTOCOL_VERSION: McpProtocolVersion = MCP_PROTOCOL_VERSIONS[0];
export const MCP_MIN_PROTOCOL_VERSION: McpProtocolVersion =
  MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1];

/**
 * Default version returned when a client either omits `protocolVersion` from
 * `initialize` or sends a version we do not recognise. We pick the OLDEST
 * supported version when the client omits (most conservative — they likely
 * predate version negotiation) and the LATEST when they send a forward-dated
 * unknown (they're newer than us, downgrade them gracefully).
 */
export const MCP_DEFAULT_PROTOCOL_VERSION_FOR_MISSING: McpProtocolVersion =
  MCP_MIN_PROTOCOL_VERSION;

/** Alias retained for back-compat with existing imports — points to the oldest supported version. */
export const MCP_PROTOCOL_VERSION = MCP_MIN_PROTOCOL_VERSION;

export interface McpServerInfo {
  name: string;
  version: string;
}

/**
 * Capabilities advertised by the server during `initialize`. Only fields for
 * features the server actually implements should be set — advertising a
 * feature without a handler is a spec violation that breaks compliant clients.
 *
 * Per MCP spec: `listChanged: true` means the server will push
 * `notifications/{tools,resources,prompts}/list_changed` when its catalogue
 * changes. `subscribe: true` (resources only) means the server accepts
 * `resources/subscribe` / `resources/unsubscribe` requests.
 */
export interface McpCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  /** Empty object signals support for `logging/setLevel` + `notifications/message`. */
  logging?: Record<string, never>;
  /** Empty object signals support for `completion/complete`. */
  completions?: Record<string, never>;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
  serverInfo: McpServerInfo;
}

/**
 * Tool annotations per MCP 2025-06-18. All fields are optional; omit
 * (`undefined`) to signal "no opinion" rather than sending `null`.
 *
 * Per spec these hints are **advisory only** — a compliant client must
 * still treat every tool as untrusted. They exist to inform UX
 * (e.g. confirmation dialogs for destructive tools).
 */
export interface McpToolAnnotations {
  /** Human-readable label shown by clients in place of the technical name. */
  title?: string;
  /** true = does not modify state. */
  readOnlyHint?: boolean;
  /** true = may perform destructive updates. Only meaningful if readOnlyHint is false. */
  destructiveHint?: boolean;
  /** true = repeated calls with the same args have the same effect as one call. */
  idempotentHint?: boolean;
  /** true = interacts with an open-ended external system (web search, third-party API). */
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  /** Internal capability slug (not sent to MCP clients) */
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Present only when at least one annotation field is set. */
  annotations?: McpToolAnnotations;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/**
 * Tool result content blocks per MCP spec.
 *
 * - `text`: plain text response.
 * - `image` / `audio`: base64-encoded binary data with a MIME type.
 * - `resource`: an embedded resource (a tool returning structured data
 *   that the client should treat the same as `resources/read` output).
 *
 * Size and count limits are enforced by the tool registry — see
 * `callMcpTool` for the cap values.
 */
export type McpContentBlock =
  | McpTextContentBlock
  | McpImageContentBlock
  | McpAudioContentBlock
  | McpEmbeddedResourceContentBlock;

export interface McpTextContentBlock {
  type: 'text';
  text: string;
}

export interface McpImageContentBlock {
  type: 'image';
  /** Base64-encoded image bytes. */
  data: string;
  /** Image MIME type, e.g. `image/png`. */
  mimeType: string;
}

export interface McpAudioContentBlock {
  type: 'audio';
  /** Base64-encoded audio bytes. */
  data: string;
  /** Audio MIME type, e.g. `audio/wav`. */
  mimeType: string;
}

export interface McpEmbeddedResourceContentBlock {
  type: 'resource';
  /** The embedded resource payload, mirroring resources/read output. */
  resource: {
    uri: string;
    mimeType: string;
    text?: string;
    /** Base64-encoded binary data; mutually exclusive with `text`. */
    blob?: string;
  };
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

/**
 * MCP logging severity levels per RFC 5424, ordered most → least verbose.
 * The ordering must be preserved — `McpLogLevelRank` uses index lookup.
 */
export const MCP_LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const;
export type McpLogLevel = (typeof MCP_LOG_LEVELS)[number];

/** Numeric rank — useful for "emit if rank ≥ session level rank" comparisons. */
export const McpLogLevelRank: Record<McpLogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

export interface McpSession {
  id: string;
  apiKeyId: string;
  initialized: boolean;
  /**
   * Protocol version negotiated during `initialize`. Set to the latest
   * supported version at session creation and replaced with the negotiated
   * value once the client sends `initialize`. Per-call handlers may branch
   * on this to gate features that exist only in newer spec revisions.
   */
  protocolVersion: McpProtocolVersion;
  /**
   * Minimum severity the client wants pushed via `notifications/message`.
   * Defaults to `warning` so clients that never call `logging/setLevel`
   * don't drown in `info`/`debug` chatter. Replaced via `setLogLevel`.
   */
  logLevel: McpLogLevel;
  createdAt: number;
  lastActivityAt: number;
}

/**
 * Negotiate the protocol version to use for a session.
 *
 * Rules:
 *  - Client omits `protocolVersion` entirely → use the most conservative
 *    supported version (oldest). Likely a pre-negotiation client.
 *  - Client requests a version we support → use it exactly.
 *  - Client requests an unknown future version → downgrade to our latest.
 *  - Client requests an unknown older version → no match; return null so the
 *    caller can surface INVALID_PARAMS rather than silently misbehaving.
 *
 * Returns `null` only for the unknown-older case, which is exceptional.
 */
export function negotiateMcpProtocolVersion(
  requested: unknown
): { version: McpProtocolVersion; wasDowngraded: boolean } | null {
  if (requested === undefined || requested === null) {
    return { version: MCP_DEFAULT_PROTOCOL_VERSION_FOR_MISSING, wasDowngraded: false };
  }
  if (typeof requested !== 'string') {
    return null;
  }
  if ((MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return { version: requested as McpProtocolVersion, wasDowngraded: false };
  }
  // Date-shaped strings newer than our latest → downgrade to latest.
  // Lexicographic compare works because the format is yyyy-mm-dd.
  if (/^\d{4}-\d{2}-\d{2}$/.test(requested) && requested > MCP_LATEST_PROTOCOL_VERSION) {
    return { version: MCP_LATEST_PROTOCOL_VERSION, wasDowngraded: true };
  }
  return null;
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
