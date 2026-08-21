/**
 * MCP Transport Endpoint — Streamable HTTP
 *
 * POST   /api/v1/mcp — JSON-RPC 2.0 request
 * GET    /api/v1/mcp — SSE notification stream (keepalive only for v1)
 * DELETE /api/v1/mcp — Session termination
 *
 * Authentication: MCP API key (bearer token), not session cookies.
 * Rate limiting is layered: the proxy applies the section-level `mcp` tier
 * (300/min keyed per api-key — see `lib/security/rate-limit-policy.ts`),
 * and `McpRateLimiter` inside the handler applies the per-key sub-cap
 * configured on each `apiKey.rateLimit` row.
 */

import { NextRequest } from 'next/server';
import { handleAPIError } from '@/lib/api/errors';
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
import { createEphemeralSession } from '@/lib/orchestration/mcp/session-manager';
import { jsonRpcRequestSchema } from '@/lib/validations/mcp';
import { env } from '@/lib/env';
import {
  JsonRpcErrorCode,
  negotiateMcpProtocolVersion,
  MCP_DEFAULT_PROTOCOL_VERSION_FOR_MISSING,
  type JsonRpcResponse,
  type McpProtocolVersion,
} from '@/types/mcp';

function jsonRpcErrorResponse(code: JsonRpcErrorCode, message: string, status: number): Response {
  const headers: Record<string, string> = {};
  // Per RFC 6750 / RFC 9728 every 401 from a bearer-protected resource
  // SHOULD include a WWW-Authenticate challenge so clients can distinguish
  // "supply a bearer" from "this server has no idea how to authenticate
  // you". 2025-spec MCP clients use this to detect that the server is
  // bearer-only and skip the OAuth discovery dance.
  if (status === 401) {
    headers['WWW-Authenticate'] = `Bearer realm="sunrise-mcp", error="invalid_token"`;
  }
  return Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status, headers });
}

const MAX_BODY_SIZE = 1_048_576; // 1MB
const MAX_BATCH_SIZE = 20;
const MCP_SESSION_HEADER = 'mcp-session-id';
/** Spec revision 2025-06-18 onward: the client echoes the negotiated version per request. */
const MCP_PROTOCOL_HEADER = 'mcp-protocol-version';

/**
 * Whether this deployment holds no session state.
 *
 * Read per request rather than captured in a module-level const. There is
 * nothing to gain from caching a string comparison, and a const is evaluated
 * once at import — which in a unit test happens before any mock can change it,
 * so the whole branch silently tests as `false`. That is not hypothetical: it is
 * how a downstream implementation of this feature got 40 passing tests over a
 * path none of them took.
 */
function isStateless(): boolean {
  return env.MCP_SESSION_MODE === 'stateless';
}

/**
 * The protocol version for a stateless request, from the client's
 * `MCP-Protocol-Version` header.
 *
 * There is no session remembering what was negotiated, and defaulting to the
 * server's latest would emit annotations the client never agreed to. So the
 * header is the only evidence available.
 *
 * **Delegated to `negotiateMcpProtocolVersion` rather than re-deciding here**,
 * because "unrecognised → oldest" is only right for a *missing* or malformed
 * value. A date-shaped header NEWER than our latest comes from a client that
 * understands strictly more than we do, and flooring it to `2024-11-05` would
 * mean the newer the client, the worse it is treated — losing it the tool
 * annotations that `protocol-handler` gates on `>= 2025-06-18`, on the default
 * path. That function already draws the distinction (missing → oldest, known →
 * itself, forward-dated → downgrade to our latest, junk → reject); a second
 * rule beside it would be two docblocks disagreeing.
 *
 * A rejected value falls back to the missing-header default: the request is
 * still servable, and refusing it outright is the conformance question tracked
 * separately, not this bug.
 */
function statelessProtocolVersion(request: NextRequest): McpProtocolVersion {
  const declared = request.headers.get(MCP_PROTOCOL_HEADER);
  return (
    negotiateMcpProtocolVersion(declared ?? undefined)?.version ??
    MCP_DEFAULT_PROTOCOL_VERSION_FOR_MISSING
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const clientIp = getClientIP(request);

    // Authenticate bearer token. Section-level rate limiting is enforced
    // upstream by proxy.ts via the mcp tier (300/min keyed per api-key).
    const authHeader = request.headers.get('authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const userAgent = request.headers.get('user-agent') ?? '';

    const auth = await authenticateMcpRequest(bearerToken, clientIp, userAgent);
    if (!auth) {
      return jsonRpcErrorResponse(JsonRpcErrorCode.UNAUTHORIZED, 'Unauthorized', 401);
    }

    // 1. Check MCP server is enabled
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

    // 2. Parse request body with size limit
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

    // 3. Detect batch vs single request
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

    // 4. Session management
    const hasInitialize = validRequests.some((r) => r.method === 'initialize');
    const sessionId = request.headers.get(MCP_SESSION_HEADER);
    let session;

    // `initialize` must be alone in a batch, in BOTH modes.
    //
    // Stateful enforces it to avoid ambiguous session state. Stateless has no
    // session state to make ambiguous — but it has a subtler version of the same
    // problem: every request in the batch takes its protocol version from the
    // `MCP-Protocol-Version` header, which is absent on a handshake request, so
    // a `[initialize, tools/list]` batch would serve the `tools/list` at
    // `2024-11-05` even though the `initialize` beside it negotiated
    // `2025-06-18` microseconds earlier — silently dropping the tool annotations
    // gated on `>= 2025-06-18`.
    //
    // Keeping the guard in both modes costs nothing (spec revision 2025-06-18
    // removed JSON-RPC batching, and a 2026-07-28 client sends no `initialize`
    // at all) and removes a mode-dependent behaviour difference rather than
    // documenting one.
    if (hasInitialize && validRequests.length > 1) {
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

    if (isStateless()) {
      // Ahead of the remaining branches, so none of the session bookkeeping
      // runs: no per-key session limit, no lookup that could 404. A stale
      // `Mcp-Session-Id` from a previous stateful deploy — or from a sibling
      // instance — is simply ignored rather than rejected.
      session = createEphemeralSession(auth.apiKeyId, statelessProtocolVersion(request));
    } else if (hasInitialize) {
      // The batch-position guard now runs for both modes, above.

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

    // 5. Dispatch each request
    const handlerContext = { auth, session, serverState, rateLimiter };
    const responses: (JsonRpcResponse | null)[] = [];

    for (const rpcRequest of validRequests) {
      const response = await handleMcpRequest(rpcRequest, handlerContext);

      // Persist the negotiated protocol version + flip the session to
      // initialised after a successful `initialize` call. The version comes
      // out of the response payload, which the handler has already validated.
      if (!isStateless() && rpcRequest.method === 'initialize' && response && !response.error) {
        const result = response.result as { protocolVersion?: string } | undefined;
        const negotiated = result?.protocolVersion;
        if (
          negotiated === '2024-11-05' ||
          negotiated === '2025-06-18' // keep this list aligned with MCP_PROTOCOL_VERSIONS
        ) {
          sessionManager.setProtocolVersion(session.id, negotiated);
        }
        sessionManager.markInitialized(session.id);
      }

      responses.push(response);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Withholding this header is what makes stateless work end-to-end. The
    // Streamable HTTP transport says a client sends `Mcp-Session-Id` only if the
    // server issued one — so no header out means no id on the next request, and
    // nothing that can fail to be found. Advertising an id nothing stores would
    // be worse than having none.
    if (!isStateless()) {
      headers[MCP_SESSION_HEADER] = session.id;
    }

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

    if (isStateless()) {
      // 405, not 501: this is the status the Streamable HTTP transport
      // designates for a server that offers no GET stream, and the one clients
      // special-case as "no SSE here, carry on" instead of surfacing a transport
      // error on every healthy connect. Revision 2026-07-28 makes it explicit —
      // a modern-only server answers GET and DELETE with 405.
      //
      // After auth and the server-enabled check, so an unauthenticated GET still
      // gets 401 and a disabled server still gets 503; the method is only
      // unavailable to callers who would otherwise have been allowed to use it.
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: JsonRpcErrorCode.STATELESS_UNSUPPORTED,
            message:
              'This server does not offer an SSE stream (MCP_SESSION_MODE=stateless). ' +
              'Server-push notifications require MCP_SESSION_MODE=stateful, which needs a ' +
              'single long-running process.',
          },
        },
        { status: 405, headers: { Allow: 'POST' } }
      );
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

    const authHeader = request.headers.get('authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const userAgent = request.headers.get('user-agent') ?? '';

    const auth = await authenticateMcpRequest(bearerToken, clientIp, userAgent);
    if (!auth) {
      return jsonRpcErrorResponse(JsonRpcErrorCode.UNAUTHORIZED, 'Unauthorized', 401);
    }

    if (isStateless()) {
      // Audited before refusing, deliberately: the log records what a key ASKED
      // for, and the stateful path already writes a row for a DELETE it cannot
      // honour. A terminate request against a server with nothing to terminate
      // is a client-configuration signal worth keeping.
      logMcpAudit({
        apiKeyId: auth.apiKeyId,
        method: 'session/destroy',
        responseCode: 'error',
        errorMessage: 'Sessions are not tracked in stateless mode',
        durationMs: 0,
        clientIp: auth.clientIp,
        userAgent: auth.userAgent,
      });
      // Empty body, matching the stateful 204/404 shape — a DELETE response
      // carries no JSON-RPC envelope for a client to parse.
      return new Response(null, { status: 405, headers: { Allow: 'POST' } });
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
