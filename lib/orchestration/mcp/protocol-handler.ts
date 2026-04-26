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
  MCP_PROTOCOL_VERSION,
  McpScope,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpAuthContext,
  type McpCapabilities,
  type McpInitializeResult,
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
} from '@/lib/orchestration/mcp/resource-registry';
import { listMcpPrompts, getMcpPrompt } from '@/lib/orchestration/mcp/prompt-registry';
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
    return jsonRpcError(request.id!, JsonRpcErrorCode.INTERNAL_ERROR, 'Rate limit exceeded');
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
      return handleInitialize(context);

    case 'ping':
      return {};

    case 'tools/list':
      requireInitialized(session);
      requireScope(auth, McpScope.TOOLS_LIST);
      return handleToolsList(request.params);

    case 'tools/call':
      requireInitialized(session);
      requireScope(auth, McpScope.TOOLS_EXECUTE);
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
      return handleResourcesRead(request.params);

    case 'prompts/list':
      requireInitialized(session);
      requireScope(auth, McpScope.PROMPTS_READ);
      return handlePromptsList();

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

function handleInitialize(context: HandlerContext): McpInitializeResult {
  const { serverState } = context;

  const capabilities: McpCapabilities = {
    tools: {},
    resources: {},
    prompts: {},
  };

  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities,
    serverInfo: {
      name: serverState.serverName,
      version: serverState.serverVersion,
    },
  };
}

const DEFAULT_PAGE_SIZE = 50;

async function handleToolsList(
  params: Record<string, unknown> | undefined
): Promise<{ tools: unknown[]; nextCursor?: string }> {
  const allTools = await listMcpTools();
  const { offset, limit } = decodeCursor(params?.cursor, DEFAULT_PAGE_SIZE);
  const page = allTools.slice(offset, offset + limit);
  const nextCursor = offset + limit < allTools.length ? encodeCursor(offset + limit) : undefined;

  return {
    tools: page.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object',
        ...t.inputSchema,
      },
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
  params: Record<string, unknown> | undefined
): Promise<{ contents: unknown[] }> {
  const parsed = mcpResourceReadParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      'Invalid resource read params: uri is required'
    );
  }

  const content = await readMcpResource(parsed.data.uri);
  if (!content) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      `Resource not found: ${parsed.data.uri}`
    );
  }

  return { contents: [content] };
}

function handlePromptsList(): { prompts: unknown[] } {
  const prompts = listMcpPrompts();
  return { prompts };
}

function handlePromptsGet(params: Record<string, unknown> | undefined): { messages: unknown[] } {
  const parsed = mcpPromptGetParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      'Invalid prompt params: name is required'
    );
  }

  const messages = getMcpPrompt(
    parsed.data.name,
    (parsed.data.arguments as Record<string, unknown>) ?? {}
  );
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
