/**
 * MCP Transport Endpoint — Streamable HTTP
 *
 * POST   /api/v1/mcp — JSON-RPC 2.0 request
 * GET    /api/v1/mcp — SSE notification stream (keepalive only for v1)
 * DELETE /api/v1/mcp — Session termination
 *
 * Authentication: MCP API key (bearer token), not session cookies.
 * Rate limited at IP level via apiLimiter, then per-key via McpRateLimiter.
 */

import { NextRequest } from 'next/server';
import { handleAPIError } from '@/lib/api/errors';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { sseResponse } from '@/lib/api/sse';
import { logger } from '@/lib/logging';
import {
  authenticateMcpRequest,
  getMcpServerConfig,
  handleMcpRequest,
  getMcpSessionManager,
  getMcpRateLimiter,
  logMcpAudit,
} from '@/lib/orchestration/mcp';
import { jsonRpcRequestSchema } from '@/lib/validations/mcp';
import { JsonRpcErrorCode, type JsonRpcResponse } from '@/types/mcp';

function jsonRpcErrorResponse(code: JsonRpcErrorCode, message: string, status: number): Response {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status });
}

const MAX_BODY_SIZE = 1_048_576; // 1MB
const MAX_BATCH_SIZE = 20;
const MCP_SESSION_HEADER = 'mcp-session-id';

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const clientIp = getClientIP(request);

    // 1. IP-level rate limit
    const ipLimit = apiLimiter.check(clientIp);
    if (!ipLimit.success) return createRateLimitResponse(ipLimit);

    // 2. Authenticate bearer token
    const authHeader = request.headers.get('authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const userAgent = request.headers.get('user-agent') ?? '';

    const auth = await authenticateMcpRequest(bearerToken, clientIp, userAgent);
    if (!auth) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: JsonRpcErrorCode.UNAUTHORIZED, message: 'Unauthorized' },
        },
        { status: 401 }
      );
    }

    // 3. Check MCP server is enabled
    const serverState = await getMcpServerConfig();
    if (!serverState.isEnabled) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: JsonRpcErrorCode.SERVER_DISABLED, message: 'MCP server is disabled' },
        },
        { status: 503 }
      );
    }

    // 4. Parse request body with size limit
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: JsonRpcErrorCode.PARSE_ERROR, message: 'Request too large' },
        },
        { status: 413 }
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: JsonRpcErrorCode.PARSE_ERROR, message: 'Invalid JSON' },
        },
        { status: 400 }
      );
    }

    // 5. Detect batch vs single request
    const isBatch = Array.isArray(rawBody);
    const rawArray = isBatch ? (rawBody as unknown[]) : null;

    if (rawArray && rawArray.length === 0) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: JsonRpcErrorCode.INVALID_REQUEST, message: 'Empty batch' },
        },
        { status: 400 }
      );
    }

    if (rawArray && rawArray.length > MAX_BATCH_SIZE) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: JsonRpcErrorCode.INVALID_REQUEST,
            message: `Batch too large: max ${String(MAX_BATCH_SIZE)} requests`,
          },
        },
        { status: 400 }
      );
    }

    const requests = rawArray ?? [rawBody];

    // Validate all JSON-RPC envelopes
    const parsedRequests = requests.map((r) => jsonRpcRequestSchema.safeParse(r));
    const firstFailure = parsedRequests.find((p) => !p.success);
    if (firstFailure && !firstFailure.success) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: JsonRpcErrorCode.INVALID_REQUEST, message: 'Invalid JSON-RPC request' },
        },
        { status: 400 }
      );
    }

    const validRequests = parsedRequests.map((p) => {
      if (!p.success) throw new Error('unreachable');
      return p.data;
    });

    const sessionManager = getMcpSessionManager();
    const rateLimiter = getMcpRateLimiter();

    // 6. Session management
    const hasInitialize = validRequests.some((r) => r.method === 'initialize');
    const sessionId = request.headers.get(MCP_SESSION_HEADER);
    let session;

    if (hasInitialize) {
      // initialize must be the sole request in the batch — mixing it with
      // other methods leads to ambiguous session state.
      if (validRequests.length > 1) {
        const initReq = validRequests.find((r) => r.method === 'initialize');
        return Response.json(
          {
            jsonrpc: '2.0',
            id: initReq?.id ?? null,
            error: {
              code: JsonRpcErrorCode.INVALID_REQUEST,
              message: 'initialize must be the only request in the batch',
            },
          },
          { status: 400 }
        );
      }

      // Reject initialize when a session header is already present — prevents
      // unlimited session creation by replaying initialize-first batches.
      if (sessionId) {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: validRequests[0].id ?? null,
            error: {
              code: JsonRpcErrorCode.INVALID_REQUEST,
              message: 'Cannot send initialize with an existing session header',
            },
          },
          { status: 400 }
        );
      }

      // Create new session
      session = sessionManager.createSession(auth.apiKeyId, serverState.maxSessionsPerKey);
      if (!session) {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: validRequests[0].id ?? null,
            error: { code: JsonRpcErrorCode.SESSION_NOT_FOUND, message: 'Max sessions exceeded' },
          },
          { status: 429 }
        );
      }
    } else if (sessionId) {
      session = sessionManager.getSession(sessionId);
      if (!session || session.apiKeyId !== auth.apiKeyId) {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: validRequests[0].id ?? null,
            error: {
              code: JsonRpcErrorCode.SESSION_NOT_FOUND,
              message: 'Session not found or expired',
            },
          },
          { status: 404 }
        );
      }
    } else {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: validRequests[0].id ?? null,
          error: {
            code: JsonRpcErrorCode.INVALID_REQUEST,
            message: 'Missing Mcp-Session-Id header',
          },
        },
        { status: 400 }
      );
    }

    // 7. Dispatch each request
    const handlerContext = { auth, session, serverState, rateLimiter };
    const responses: (JsonRpcResponse | null)[] = [];

    for (const rpcRequest of validRequests) {
      const response = await handleMcpRequest(rpcRequest, handlerContext);

      // Mark session initialized after successful initialize call
      if (rpcRequest.method === 'initialize' && response && !response.error) {
        sessionManager.markInitialized(session.id);
      }

      responses.push(response);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    headers[MCP_SESSION_HEADER] = session.id;

    if (isBatch) {
      // Filter out nulls (notifications don't produce responses)
      const batchResponses = responses.filter((r): r is JsonRpcResponse => r !== null);
      if (batchResponses.length === 0) {
        return new Response(null, { status: 204 });
      }
      return Response.json(batchResponses, { headers });
    }

    // Single request
    const singleResponse = responses[0];
    if (singleResponse === null) {
      return new Response(null, { status: 204 });
    }

    return Response.json(singleResponse, { headers });
  } catch (error) {
    logger.error('MCP transport: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return handleAPIError(error);
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const clientIp = getClientIP(request);
    const ipLimit = apiLimiter.check(clientIp);
    if (!ipLimit.success) return createRateLimitResponse(ipLimit);

    const authHeader = request.headers.get('authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const userAgent = request.headers.get('user-agent') ?? '';

    const auth = await authenticateMcpRequest(bearerToken, clientIp, userAgent);
    if (!auth) {
      return jsonRpcErrorResponse(JsonRpcErrorCode.UNAUTHORIZED, 'Unauthorized', 401);
    }

    const serverState = await getMcpServerConfig();
    if (!serverState.isEnabled) {
      return jsonRpcErrorResponse(JsonRpcErrorCode.SERVER_DISABLED, 'MCP server is disabled', 503);
    }

    const sessionId = request.headers.get(MCP_SESSION_HEADER);
    const sessionManager = getMcpSessionManager();

    // SSE notification stream with server-push notifications
    async function* notificationStream(): AsyncIterable<{ type: string; data?: string }> {
      yield { type: 'connected' };

      // Create a queue that the session manager can push notifications into
      const queue: Array<{ type: string; data?: string }> = [];
      let resolve: (() => void) | null = null;
      let aborted = false;

      // Wire request.signal so a client disconnect resolves any pending await
      const onAbort = (): void => {
        aborted = true;
        if (resolve) {
          resolve();
          resolve = null;
        }
      };
      request.signal.addEventListener('abort', onAbort, { once: true });

      if (sessionId) {
        sessionManager.registerSseListener(sessionId, (notification) => {
          queue.push({
            type: 'notification',
            data: JSON.stringify(notification),
          });
          if (resolve) {
            resolve();
            resolve = null;
          }
        });
      }

      try {
        // Yield notifications as they arrive
        while (!aborted) {
          if (queue.length > 0) {
            yield queue.shift()!;
          } else {
            await new Promise<void>((r) => {
              resolve = r;
            });
          }
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        if (sessionId) {
          sessionManager.unregisterSseListener(sessionId);
        }
      }
    }

    return sseResponse(notificationStream(), { signal: request.signal });
  } catch (error) {
    return handleAPIError(error);
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  try {
    const clientIp = getClientIP(request);
    const ipLimit = apiLimiter.check(clientIp);
    if (!ipLimit.success) return createRateLimitResponse(ipLimit);

    const authHeader = request.headers.get('authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const userAgent = request.headers.get('user-agent') ?? '';

    const auth = await authenticateMcpRequest(bearerToken, clientIp, userAgent);
    if (!auth) {
      return jsonRpcErrorResponse(JsonRpcErrorCode.UNAUTHORIZED, 'Unauthorized', 401);
    }

    const sessionId = request.headers.get(MCP_SESSION_HEADER);
    if (!sessionId) {
      return jsonRpcErrorResponse(
        JsonRpcErrorCode.INVALID_REQUEST,
        'Missing Mcp-Session-Id header',
        400
      );
    }

    const sessionManager = getMcpSessionManager();
    const session = sessionManager.getSession(sessionId);
    if (session && session.apiKeyId !== auth.apiKeyId) {
      return jsonRpcErrorResponse(JsonRpcErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }
    const destroyed = session ? sessionManager.destroySession(sessionId) : false;

    logMcpAudit({
      apiKeyId: auth.apiKeyId,
      method: 'session/destroy',
      responseCode: destroyed ? 'success' : 'error',
      errorMessage: destroyed ? undefined : 'Session not found',
      durationMs: 0,
      clientIp: auth.clientIp,
      userAgent: auth.userAgent,
    });

    return new Response(null, { status: destroyed ? 204 : 404 });
  } catch (error) {
    return handleAPIError(error);
  }
}
