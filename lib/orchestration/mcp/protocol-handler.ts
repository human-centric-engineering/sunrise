/**
 * MCP Protocol Handler
 *
 * Central JSON-RPC 2.0 router for MCP server operations. Dispatches
 * incoming requests to the appropriate registry (tools, resources,
 * prompts) with scope checking, rate limiting, and audit logging.
 *
 * Platform-agnostic: no Next.js imports.
 *
 * Tenancy posture: row-keyed — `keyRateLimitCache` by MCP API key id,
 * refreshed under the system scope (lib/tenancy/process-state.ts).
 */

import { logger } from '@/lib/logging';
import {
  JsonRpcErrorCode,
  McpScope,
  negotiateMcpProtocolVersion,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpAuthContext,
  type McpCapabilities,
  type McpInitializeResult,
  type McpProtocolVersion,
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
import {
  completeMcpReference,
  type McpCompletionRef,
} from '@/lib/orchestration/mcp/completion-registry';
import type { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';
import type { McpServerState } from '@/lib/orchestration/mcp/types';

interface HandlerContext {
  auth: McpAuthContext;
  /**
   * The revision to answer this request at.
   *
   * A request, not a session (§39 t-718): every MCP request now stands alone,
   * so the version comes from the caller's `MCP-Protocol-Version` header —
   * resolved once in the transport — or from `initialize`'s own params on the
   * handshake. It used to be read off a stored session, which is why the field
   * it replaced could be stale for the life of a process.
   */
  protocolVersion: McpProtocolVersion;
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
  const { auth, protocolVersion } = context;

  switch (request.method) {
    case 'initialize':
      return handleInitialize(request.params, context);

    case 'ping':
      return {};

    case 'tools/list':
      requireScope(auth, McpScope.TOOLS_LIST);
      return handleToolsList(request.params, protocolVersion, auth);

    case 'tools/call':
      requireScope(auth, McpScope.TOOLS_EXECUTE);
      return handleToolsCall(request.params, auth);

    case 'resources/list':
      requireScope(auth, McpScope.RESOURCES_READ);
      return handleResourcesList(request.params);

    case 'resources/templates/list':
      requireScope(auth, McpScope.RESOURCES_READ);
      return handleResourcesTemplatesList();

    case 'resources/read':
      requireScope(auth, McpScope.RESOURCES_READ);
      return handleResourcesRead(request.params, auth);

    case 'completion/complete':
      // Scope check is per ref-type and happens inside the handler — a
      // prompt-ref needs prompts:read, a resource-ref needs resources:read.
      return handleCompletionComplete(request.params, auth);

    case 'prompts/list':
      requireScope(auth, McpScope.PROMPTS_READ);
      return handlePromptsList(request.params);

    case 'prompts/get':
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
  //
  // Every capability that PUSHES is absent, and permanently (§39 t-718):
  // `listChanged` promises `notifications/{tools,resources,prompts}/list_changed`,
  // `resources.subscribe` promises `notifications/resources/updated`, and
  // `logging: {}` IS the signal that `logging/setLevel` and
  // `notifications/message` work. All four needed a session and a
  // server-to-client stream outliving the request; there is neither. Not
  // advertising is the fix rather than refusing the calls, because a conforming
  // client then never asks — the refusals are gone too, so an attempt now gets
  // METHOD_NOT_FOUND like any other unknown method.
  //
  // `completions` stays: `completion/complete` is a plain request/response
  // lookup that pushes nothing.
  const capabilities: McpCapabilities = {
    tools: {},
    resources: {},
    prompts: {},
    completions: {},
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
  protocolVersion: McpProtocolVersion,
  auth: McpAuthContext
): Promise<{ tools: unknown[]; nextCursor?: string }> {
  // Scope the catalogue to the key's agent so discovery matches dispatch: a
  // tool disabled for the scoped agent (which `tools/call` would refuse) is
  // hidden here. Unscoped keys see the full list. See listMcpTools (#381).
  const allTools = await listMcpTools(auth.scopedAgentId);
  const { offset, limit } = decodeCursor(params?.cursor, DEFAULT_PAGE_SIZE);
  const page = allTools.slice(offset, offset + limit);
  const nextCursor = offset + limit < allTools.length ? encodeCursor(offset + limit) : undefined;

  // Annotations are a 2025-06-18 addition. Emit them only when the caller
  // declared that version or newer; for 2024-11-05 clients the field is
  // silently dropped (the spec says clients SHOULD ignore unknown fields,
  // but being clean is cheap).
  const emitAnnotations = protocolVersion >= '2025-06-18';

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

  const result = await callMcpTool(parsed.data.name, parsed.data.arguments, {
    userId: auth.createdBy,
    scopedAgentId: auth.scopedAgentId,
    ...(auth.scope ? { scope: auth.scope } : {}),
  });

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
    userId: auth.createdBy,
  });
  if (!content) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      `Resource not found: ${parsed.data.uri}`
    );
  }

  return { contents: [content] };
}

async function handleCompletionComplete(
  params: Record<string, unknown> | undefined,
  auth: McpAuthContext
): Promise<unknown> {
  const ref = parseCompletionRef(params?.ref);
  const argument = params?.argument;
  if (
    argument === null ||
    typeof argument !== 'object' ||
    typeof (argument as { name?: unknown }).name !== 'string' ||
    typeof (argument as { value?: unknown }).value !== 'string'
  ) {
    throw new McpProtocolError(
      JsonRpcErrorCode.INVALID_PARAMS,
      'argument must be { name: string, value: string }'
    );
  }
  const { name: argName, value } = argument as { name: string; value: string };

  // Scope per ref-type — a prompt completion is metadata about a prompt
  // (prompts:read), a resource template completion is metadata about a
  // resource (resources:read). Without this gate, completion would be a
  // free side-channel around the scope check on prompts/list and
  // resources/list.
  const requiredScope = ref.type === 'ref/prompt' ? McpScope.PROMPTS_READ : McpScope.RESOURCES_READ;
  requireScope(auth, requiredScope);

  try {
    return await completeMcpReference(ref, argName, value);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, err.message);
    }
    throw err;
  }
}

function parseCompletionRef(raw: unknown): McpCompletionRef {
  if (raw === null || typeof raw !== 'object') {
    throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, 'ref is required');
  }
  const type = (raw as { type?: unknown }).type;
  if (type === 'ref/prompt') {
    const name = (raw as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, 'ref/prompt requires name');
    }
    return { type: 'ref/prompt', name };
  }
  if (type === 'ref/resource') {
    const uri = (raw as { uri?: unknown }).uri;
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, 'ref/resource requires uri');
    }
    return { type: 'ref/resource', uri };
  }
  throw new McpProtocolError(
    JsonRpcErrorCode.INVALID_PARAMS,
    'ref.type must be "ref/prompt" or "ref/resource"'
  );
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

/**
 * Per-key rate-limit overrides from `McpApiKey.rateLimitOverride`, keyed by
 * key id — unique across orgs, so one process-wide map is correct.
 *
 * Filling it is the part that is not (§108 t-712). The refresh is kicked off
 * from `getKeyRateLimit` on the request path, so it inherited whichever org
 * that request was running as, and `McpApiKey` is tenant-owned: at `multi` the
 * map then held one org's overrides and every other org's key fell back to the
 * default limit for the next five minutes — silently, and differently
 * depending on who happened to refresh it. The read is genuinely global, so it
 * takes the audited system scope, exactly as the maintenance tick's idle-gate
 * horizon does.
 */
let keyRateLimitCache = new Map<string, number | null>();
let keyRateLimitCacheAt = 0;
/**
 * The refresh in flight, if any.
 *
 * `getKeyRateLimit` kicks the refresh off without awaiting it, and the
 * freshness stamp is only written when it resolves — so without this latch
 * every request arriving during a refresh starts another one. That was a
 * duplicate query before; now each duplicate is an audited RLS bypass with an
 * `info` line, and a burst at a five-minute boundary would produce N of them,
 * drowning the signal that log exists to give (`lib/tenancy/context.ts`).
 * Same shape as `model-registry-db-hydrate.ts`.
 */
let keyRateLimitRefresh: Promise<void> | null = null;
/**
 * The earliest a failed refresh may be retried.
 *
 * The freshness stamp is only written on success, so without this a failing
 * query is re-attempted by EVERY request — the latch dedupes concurrent
 * refreshes, not serial ones — and each attempt is an audited bypass with its
 * own `info` line. A pool exhausted for a minute under load would emit one
 * per request, which is the drowning the latch exists to prevent, arriving by
 * the other door. Thirty seconds rather than the full TTL: a transient blip
 * should not cost five minutes of every org's overrides.
 */
let keyRateLimitRetryAt = 0;
const KEY_RATE_CACHE_TTL = 5 * 60 * 1000;
const KEY_RATE_FAILURE_BACKOFF_MS = 30 * 1000;

async function loadKeyRateLimits(): Promise<void> {
  const { prisma } = await import('@/lib/db/client');
  const { runAsSystem } = await import('@/lib/tenancy/context');
  const keys = await runAsSystem(
    'mcp: per-key rate-limit overrides, which are keyed by a key id and read for every org',
    () =>
      prisma.mcpApiKey.findMany({
        where: { isActive: true, rateLimitOverride: { not: null } },
        select: { id: true, rateLimitOverride: true },
      })
  );
  const map = new Map<string, number | null>();
  for (const k of keys) {
    map.set(k.id, k.rateLimitOverride);
  }
  keyRateLimitCache = map;
  keyRateLimitCacheAt = Date.now();
}

/**
 * Test-only: forget the overrides so the next lookup refreshes.
 *
 * The cache is module state with a five-minute TTL, so without this a test
 * asserting on the refresh depends on being the first in its file to reach
 * this code path.
 */
export function __resetKeyRateLimitCacheForTests(): void {
  keyRateLimitCache = new Map<string, number | null>();
  keyRateLimitCacheAt = 0;
  keyRateLimitRefresh = null;
  keyRateLimitRetryAt = 0;
}

/**
 * Start a refresh unless one is already running, and never reject.
 *
 * The caller cannot await this — the limit is wanted now, from whatever the
 * cache holds — so a database failure here has nowhere to go but a log line.
 * Before this it had nowhere to go at all: an unhandled rejection.
 */
function refreshKeyRateLimits(): void {
  if (keyRateLimitRefresh || Date.now() < keyRateLimitRetryAt) return;
  keyRateLimitRefresh = loadKeyRateLimits()
    .catch((err: unknown) => {
      keyRateLimitRetryAt = Date.now() + KEY_RATE_FAILURE_BACKOFF_MS;
      logger.warn('MCP per-key rate-limit overrides could not be refreshed', {
        error: err instanceof Error ? err.message : String(err),
        retryInMs: KEY_RATE_FAILURE_BACKOFF_MS,
      });
    })
    .finally(() => {
      keyRateLimitRefresh = null;
    });
}

function getKeyRateLimit(apiKeyId: string): number | null {
  if (Date.now() - keyRateLimitCacheAt > KEY_RATE_CACHE_TTL) {
    refreshKeyRateLimits();
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
