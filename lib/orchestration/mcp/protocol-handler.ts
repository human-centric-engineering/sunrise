/**
 * MCP Protocol Handler
 *
 * Central JSON-RPC 2.0 router for MCP server operations. Dispatches
 * incoming requests to the appropriate registry (tools, resources,
 * prompts) with scope checking, rate limiting, and audit logging.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';
import {
  JsonRpcErrorCode,
  MCP_LOG_LEVELS,
  McpScope,
  negotiateMcpProtocolVersion,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpAuthContext,
  type McpCapabilities,
  type McpInitializeResult,
  type McpLogLevel,
  type McpSession,
} from '@/types/mcp';
import {
  mcpToolCallParamsSchema,
  mcpResourceReadParamsSchema,
  mcpPromptGetParamsSchema,
} from '@/lib/validations/mcp';
import { hasScope } from '@/lib/orchestration/mcp/auth';
import { logMcpAudit } from '@/lib/orchestration/mcp/audit-logger';
import { listMcpTools, callMcpTool } from '@/lib/orchestration/mcp/tool-registry';
import {
  listMcpResources,
  readMcpResource,
  listMcpResourceTemplates,
  isRegisteredMcpResourceUri,
} from '@/lib/orchestration/mcp/resource-registry';
import { getMcpSessionManager } from '@/lib/orchestration/mcp/singletons';
import { listMcpPrompts, getMcpPrompt } from '@/lib/orchestration/mcp/prompt-registry';
import { extractProgressToken } from '@/lib/orchestration/mcp/progress-tracker';
import type { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';
import type { McpServerState } from '@/lib/orchestration/mcp/types';

interface HandlerContext {
  auth: McpAuthContext;
  session: McpSession;
  serverState: McpServerState;
  rateLimiter: McpRateLimiter;
}

/**
 * Process a single JSON-RPC 2.0 request and return the response.
 *
 * Notifications (requests without `id`) are handled but return null
 * since JSON-RPC notifications don't expect a response.
 */
export async function handleMcpRequest(
  request: JsonRpcRequest,
  context: HandlerContext
): Promise<JsonRpcResponse | null> {
  const startedAt = Date.now();
  const { auth, serverState, rateLimiter } = context;
  const isNotification = request.id === undefined || request.id === null;

  // Handle client notifications (no response expected)
  if (isNotification) {
    return handleNotification(request.method);
  }

  // Rate limit check (per-key)
  const effectiveLimit = getKeyRateLimit(auth.apiKeyId) ?? serverState.globalRateLimit;
  const rateResult = rateLimiter.check(auth.apiKeyId, effectiveLimit);
  if (!rateResult.success) {
    logMcpAudit({
      apiKeyId: auth.apiKeyId,
      method: request.method,
      toolSlug: extractToolSlug(request),
      resourceUri: extractResourceUri(request),
      responseCode: 'rate_limited',
      durationMs: Date.now() - startedAt,
      clientIp: auth.clientIp,
      userAgent: auth.userAgent,
    });
    return jsonRpcError(request.id!, JsonRpcErrorCode.RATE_LIMITED, 'Rate limit exceeded');
  }

  try {
    const result = await dispatchMethod(request, context);

    logMcpAudit({
      apiKeyId: auth.apiKeyId,
      method: request.method,
      toolSlug: extractToolSlug(request),
      resourceUri: extractResourceUri(request),
      requestParams: request.params,
      responseCode: 'success',
      durationMs: Date.now() - startedAt,
      clientIp: auth.clientIp,
      userAgent: auth.userAgent,
    });

    return jsonRpcSuccess(request.id!, result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Internal error';
    const errorCode = err instanceof McpProtocolError ? err.code : JsonRpcErrorCode.INTERNAL_ERROR;

    logMcpAudit({
      apiKeyId: auth.apiKeyId,
      method: request.method,
      toolSlug: extractToolSlug(request),
      resourceUri: extractResourceUri(request),
      requestParams: request.params,
      responseCode: 'error',
      errorMessage: errorMsg,
      durationMs: Date.now() - startedAt,
      clientIp: auth.clientIp,
      userAgent: auth.userAgent,
    });

    // Never leak internal details in production
    const safeMessage = err instanceof McpProtocolError ? err.message : 'Internal server error';
    return jsonRpcError(request.id!, errorCode, safeMessage);
  }
}

/**
 * Dispatch to the appropriate method handler.
 */
async function dispatchMethod(request: JsonRpcRequest, context: HandlerContext): Promise<unknown> {
  const { auth, session } = context;

  switch (request.method) {
    case 'initialize':
      return handleInitialize(request.params, context);

    case 'ping':
      return {};

    case 'tools/list':
      requireInitialized(session);
      requireScope(auth, McpScope.TOOLS_LIST);
      return handleToolsList(request.params, session);

    case 'tools/call':
      requireInitialized(session);
      requireScope(auth, McpScope.TOOLS_EXECUTE);
      // Validate the optional progress token early so a bad shape gets a
      // clean INVALID_PARAMS instead of silently being ignored. Reporter
      // wiring into capabilities is opt-in and lands per-capability.
      validateProgressToken(request.params);
      return handleToolsCall(request.params, auth);

    case 'resources/list':
      requireInitialized(session);
      requireScope(auth, McpScope.RESOURCES_READ);
      return handleResourcesList(request.params);

    case 'resources/templates/list':
      requireInitialized(session);
      requireScope(auth, McpScope.RESOURCES_READ);
      return handleResourcesTemplatesList();

    case 'resources/read':
      requireInitialized(session);
      requireScope(auth, McpScope.RESOURCES_READ);
      validateProgressToken(request.params);
      return handleResourcesRead(request.params, auth);

    case 'resources/subscribe':
      requireInitialized(session);
      requireScope(auth, McpScope.RESOURCES_READ);
      return handleResourcesSubscribe(request.params, session);

    case 'resources/unsubscribe':
      requireInitialized(session);
      requireScope(auth, McpScope.RESOURCES_READ);
      return handleResourcesUnsubscribe(request.params, session);

    case 'logging/setLevel':
      requireInitialized(session);
      // Logging level is a per-session knob; the spec does not require a
      // scope. Anyone with a valid session can ask for less verbose logs.
      return handleLoggingSetLevel(request.params, session);

    case 'prompts/list':
      requireInitialized(session);
      requireScope(auth, McpScope.PROMPTS_READ);
      return handlePromptsList(request.params);

    case 'prompts/get':
      requireInitialized(session);
      requireScope(auth, McpScope.PROMPTS_READ);
      return handlePromptsGet(request.params);

    default:
      throw new McpProtocolError(
        JsonRpcErrorCode.METHOD_NOT_FOUND,
        `Unknown method: ${request.method}`
      );
  }
}

// ============================================================================
// Method Handlers
// ============================================================================

function handleInitialize(
  params: Record<string, unknown> | undefined,
  context: HandlerContext
): McpInitializeResult {
  const { serverState } = context;

  const negotiation = negotiateMcpProtocolVersion(params?.protocolVersion);
  if (!negotiation) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      'Unsupported protocolVersion. The server supports 2025-06-18 and 2024-11-05.'
    );
  }

  if (negotiation.wasDowngraded) {
    logger.info('MCP initialize: downgraded client to latest supported version', {
      requested: params?.protocolVersion,
      negotiated: negotiation.version,
    });
  }

  // Advertise only features that have working handlers in this build.
  // tools / resources / prompts broadcast list_changed when the admin mutates
  // their catalogue. resources.subscribe accepts resources/subscribe +
  // resources/unsubscribe and pushes notifications/resources/updated.
  // logging:{} signals support for logging/setLevel + notifications/message.
  // completions land in Phase 6.
  const capabilities: McpCapabilities = {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    prompts: { listChanged: true },
    logging: {},
  };

  return {
    protocolVersion: negotiation.version,
    capabilities,
    serverInfo: {
      name: serverState.serverName,
      version: serverState.serverVersion,
    },
  };
}

const DEFAULT_PAGE_SIZE = 50;

async function handleToolsList(
  params: Record<string, unknown> | undefined,
  session: McpSession
): Promise<{ tools: unknown[]; nextCursor?: string }> {
  const allTools = await listMcpTools();
  const { offset, limit } = decodeCursor(params?.cursor, DEFAULT_PAGE_SIZE);
  const page = allTools.slice(offset, offset + limit);
  const nextCursor = offset + limit < allTools.length ? encodeCursor(offset + limit) : undefined;

  // Annotations are a 2025-06-18 addition. Emit them only when the session
  // negotiated that version or newer; for 2024-11-05 clients the field is
  // silently dropped (the spec says clients SHOULD ignore unknown fields,
  // but being clean is cheap).
  const emitAnnotations = session.protocolVersion >= '2025-06-18';

  return {
    tools: page.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object',
        ...t.inputSchema,
      },
      ...(emitAnnotations && t.annotations ? { annotations: t.annotations } : {}),
    })),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

async function handleToolsCall(
  params: Record<string, unknown> | undefined,
  auth: McpAuthContext
): Promise<unknown> {
  const parsed = mcpToolCallParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      `Invalid tool call params: ${parsed.error.issues.map((i) => i.message).join(', ')}`
    );
  }

  const result = await callMcpTool(parsed.data.name, parsed.data.arguments, auth.createdBy);

  return result;
}

async function handleResourcesList(
  params: Record<string, unknown> | undefined
): Promise<{ resources: unknown[]; nextCursor?: string }> {
  const allResources = await listMcpResources();
  const { offset, limit } = decodeCursor(params?.cursor, DEFAULT_PAGE_SIZE);
  const page = allResources.slice(offset, offset + limit);
  const nextCursor =
    offset + limit < allResources.length ? encodeCursor(offset + limit) : undefined;

  return {
    resources: page,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

async function handleResourcesTemplatesList(): Promise<{ resourceTemplates: unknown[] }> {
  const templates = await listMcpResourceTemplates();
  return { resourceTemplates: templates };
}

async function handleResourcesRead(
  params: Record<string, unknown> | undefined,
  auth: import('@/types/mcp').McpAuthContext
): Promise<{ contents: unknown[] }> {
  const parsed = mcpResourceReadParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      'Invalid resource read params: uri is required'
    );
  }

  const content = await readMcpResource(parsed.data.uri, {
    scopedAgentId: auth.scopedAgentId,
    apiKeyId: auth.apiKeyId,
  });
  if (!content) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      `Resource not found: ${parsed.data.uri}`
    );
  }

  return { contents: [content] };
}

async function handleResourcesSubscribe(
  params: Record<string, unknown> | undefined,
  session: McpSession
): Promise<Record<string, never>> {
  const uri = extractUri(params);

  // Subscriptions are for concrete URIs only — clients can't subscribe
  // to a template (`sunrise://patterns/{id}`). Detect template syntax
  // before any registry lookup so we give a clear error.
  if (uri.includes('{') || uri.includes('}')) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      'Cannot subscribe to a template URI. Subscribe to concrete instances only (e.g. sunrise://patterns/5, not sunrise://patterns/{id}).'
    );
  }

  // Reject ghost subscriptions to URIs the registry doesn't know about —
  // those clients would never receive an update notification anyway.
  if (!(await isRegisteredMcpResourceUri(uri))) {
    throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, `Unknown resource URI: ${uri}`);
  }

  const result = getMcpSessionManager().subscribe(session.id, uri);
  if (result === 'limit-exceeded') {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_REQUEST,
      'Subscription limit exceeded. Unsubscribe from existing URIs before adding more.'
    );
  }
  if (result === 'session-not-found') {
    throw new McpProtocolError(JsonRpcErrorCode.SESSION_NOT_FOUND, 'Session not found or expired');
  }
  // Per spec, the response payload is an empty object.
  return {};
}

async function handleResourcesUnsubscribe(
  params: Record<string, unknown> | undefined,
  session: McpSession
): Promise<Record<string, never>> {
  const uri = extractUri(params);
  const result = getMcpSessionManager().unsubscribe(session.id, uri);
  if (result === 'session-not-found') {
    throw new McpProtocolError(JsonRpcErrorCode.SESSION_NOT_FOUND, 'Session not found or expired');
  }
  return Promise.resolve({});
}

function handleLoggingSetLevel(
  params: Record<string, unknown> | undefined,
  session: McpSession
): Record<string, never> {
  const level = params?.level;
  if (typeof level !== 'string') {
    throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, 'level is required');
  }
  if (!(MCP_LOG_LEVELS as readonly string[]).includes(level)) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      `Unknown level: ${level}. Expected one of: ${MCP_LOG_LEVELS.join(', ')}`
    );
  }
  getMcpSessionManager().setLogLevel(session.id, level as McpLogLevel);
  return {};
}

/**
 * Validate `params._meta.progressToken` shape if present. Throws
 * `INVALID_PARAMS` for malformed tokens; no-op for absent tokens.
 */
function validateProgressToken(params: Record<string, unknown> | undefined): void {
  const meta = params?._meta;
  if (meta === undefined || meta === null) return;
  if (typeof meta !== 'object') {
    throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, '_meta must be an object');
  }
  try {
    extractProgressToken(meta as Record<string, unknown>);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, err.message);
    }
    throw err;
  }
}

function extractUri(params: Record<string, unknown> | undefined): string {
  const uri = params?.uri;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, 'uri is required');
  }
  if (uri.length > 500) {
    throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, 'uri exceeds 500 char limit');
  }
  return uri;
}

async function handlePromptsList(
  params: Record<string, unknown> | undefined
): Promise<{ prompts: unknown[]; nextCursor?: string }> {
  const allPrompts = await listMcpPrompts();
  const { offset, limit } = decodeCursor(params?.cursor, DEFAULT_PAGE_SIZE);
  const page = allPrompts.slice(offset, offset + limit);
  const nextCursor = offset + limit < allPrompts.length ? encodeCursor(offset + limit) : undefined;

  return {
    prompts: page,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

async function handlePromptsGet(
  params: Record<string, unknown> | undefined
): Promise<{ messages: unknown[] }> {
  const parsed = mcpPromptGetParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      'Invalid prompt params: name is required'
    );
  }

  let messages: import('@/types/mcp').McpPromptMessage[] | null;
  try {
    messages = await getMcpPrompt(
      parsed.data.name,
      (parsed.data.arguments as Record<string, unknown>) ?? {}
    );
  } catch (err) {
    // Registry signals validation failures (missing required arg, oversize
    // output) via RangeError. Surface them as INVALID_PARAMS with the
    // original message so clients see precisely what went wrong.
    if (err instanceof RangeError) {
      throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, err.message);
    }
    throw err;
  }

  if (!messages) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      `Prompt not found: ${parsed.data.name}`
    );
  }

  return { messages };
}

// ============================================================================
// Notifications (accepted, no response)
// ============================================================================

function handleNotification(method: string): null {
  // Accept known client notifications per MCP spec
  if (
    method === 'notifications/initialized' ||
    method === 'notifications/roots/list_changed' ||
    method === 'notifications/cancelled'
  ) {
    logger.info('MCP notification received', { method });
  }
  return null;
}

// ============================================================================
// Helpers
// ============================================================================

function requireInitialized(session: McpSession): void {
  if (!session.initialized) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INTERNAL_ERROR,
      'Session not initialized — call initialize first'
    );
  }
}

function requireScope(auth: McpAuthContext, scope: string): void {
  if (!hasScope(auth, scope)) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INTERNAL_ERROR,
      `Insufficient scope: ${scope} required`
    );
  }
}

function jsonRpcSuccess(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function extractToolSlug(request: JsonRpcRequest): string | undefined {
  if (request.method !== 'tools/call') return undefined;
  const params = request.params;
  if (params && typeof params.name === 'string') return params.name;
  return undefined;
}

function extractResourceUri(request: JsonRpcRequest): string | undefined {
  if (request.method !== 'resources/read') return undefined;
  const params = request.params;
  if (params && typeof params.uri === 'string') return params.uri;
  return undefined;
}

/** Placeholder — override rate limit from McpApiKey.rateLimitOverride */
let keyRateLimitCache = new Map<string, number | null>();
let keyRateLimitCacheAt = 0;
const KEY_RATE_CACHE_TTL = 5 * 60 * 1000;

async function loadKeyRateLimits(): Promise<void> {
  const { prisma } = await import('@/lib/db/client');
  const keys = await prisma.mcpApiKey.findMany({
    where: { isActive: true, rateLimitOverride: { not: null } },
    select: { id: true, rateLimitOverride: true },
  });
  const map = new Map<string, number | null>();
  for (const k of keys) {
    map.set(k.id, k.rateLimitOverride);
  }
  keyRateLimitCache = map;
  keyRateLimitCacheAt = Date.now();
}

function getKeyRateLimit(apiKeyId: string): number | null {
  if (Date.now() - keyRateLimitCacheAt > KEY_RATE_CACHE_TTL) {
    void loadKeyRateLimits();
  }
  return keyRateLimitCache.get(apiKeyId) ?? null;
}

// ============================================================================
// Cursor-based pagination
// ============================================================================

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString('base64');
}

function decodeCursor(cursor: unknown, defaultLimit: number): { offset: number; limit: number } {
  if (typeof cursor !== 'string' || !cursor) {
    return { offset: 0, limit: defaultLimit };
  }
  try {
    const decoded = parseInt(Buffer.from(cursor, 'base64').toString('utf-8'), 10);
    if (!Number.isSafeInteger(decoded) || decoded < 0) return { offset: 0, limit: defaultLimit };
    return { offset: decoded, limit: defaultLimit };
  } catch {
    return { offset: 0, limit: defaultLimit };
  }
}

// ============================================================================
// Error class
// ============================================================================

export class McpProtocolError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
    this.name = 'McpProtocolError';
  }
}
