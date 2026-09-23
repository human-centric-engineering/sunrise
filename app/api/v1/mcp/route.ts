/**
 * MCP Transport Endpoint — Streamable HTTP
 *
 * POST   /api/v1/mcp — JSON-RPC 2.0 request. The only method this server has.
 * GET    /api/v1/mcp — 405, `Allow: POST`
 * DELETE /api/v1/mcp — 405, `Allow: POST`
 *
 * **There is one transport and it holds nothing** (§39 t-718). Every request
 * stands alone: no `Mcp-Session-Id` is issued, one arriving on a request is
 * ignored, and there is no server-to-client stream. That is the shape MCP
 * revision 2026-07-28 specifies — it removes protocol-level sessions, the
 * `initialize` handshake and the GET stream, tells a server to answer 405 for
 * GET and DELETE, and moves server-push to `subscriptions/listen`, which Sunrise
 * does not implement yet. `initialize` is still answered, for older clients that
 * open with one.
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
import { logger } from '@/lib/logging';
import {
  authenticateMcpRequest,
  getMcpServerConfig,
  handleMcpRequest,
  getMcpRateLimiter,
} from '@/lib/orchestration/mcp';
import { jsonRpcRequestSchema } from '@/lib/validations/mcp';
import { runAsOrg } from '@/lib/tenancy/context';
import {
  JsonRpcErrorCode,
  type McpAuthContext,
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
/** Spec revision 2025-06-18 onward: the client echoes the negotiated version per request. */
const MCP_PROTOCOL_HEADER = 'mcp-protocol-version';

/** Every unsupported method answers with this. */
const METHOD_NOT_ALLOWED_HEADERS = { Allow: 'POST' } as const;

/**
 * Authenticate the bearer, then run `handler` inside the key's org (§106).
 *
 * POST is the only verb that gets here. No guard wraps this route, so it
 * enters the org itself: `authenticateMcpRequest` has already applied the
 * read rule (a suspended org's key, or a null-org key at `multi`, is a 401
 * here), and everything the handler does — tool calls, resource reads, the
 * audit row — runs as that org. Section-level rate limiting is enforced
 * upstream by proxy.ts via the mcp tier (300/min keyed per api-key).
 */
async function withMcpKey(
  request: NextRequest,
  handler: (auth: McpAuthContext) => Promise<Response>
): Promise<Response> {
  const clientIp = getClientIP(request);
  const authHeader = request.headers.get('authorization') ?? '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const userAgent = request.headers.get('user-agent') ?? '';

  const auth = await authenticateMcpRequest(bearerToken, clientIp, userAgent);
  if (!auth) {
    return jsonRpcErrorResponse(JsonRpcErrorCode.UNAUTHORIZED, 'Unauthorized', 401);
  }

  // The handler's own failure is caught INSIDE the org (§108 t-714). Each
  // verb's outer catch sits outside `runAsOrg`, so an error that reached it
  // was logged with no org — and once the admin Logs page is scoped to the
  // reading org, the org whose MCP call failed is the one org that cannot see
  // it. The outer catches remain for what happens before an org is known:
  // `authenticateMcpRequest` itself.
  return runAsOrg(
    auth.orgId,
    async () => {
      try {
        return await handler(auth);
      } catch (error) {
        logger.error('MCP transport: unhandled error', {
          error: error instanceof Error ? error.message : String(error),
        });
        return handleAPIError(error);
      }
    },
    { source: 'mcp-key' }
  );
}

/**
 * The protocol version for this request, from the client's
 * `MCP-Protocol-Version` header.
 *
 * Nothing remembers what was negotiated, and defaulting to the
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
function declaredProtocolVersion(request: NextRequest): McpProtocolVersion {
  const declared = request.headers.get(MCP_PROTOCOL_HEADER);
  return (
    negotiateMcpProtocolVersion(declared ?? undefined)?.version ??
    MCP_DEFAULT_PROTOCOL_VERSION_FOR_MISSING
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    return await withMcpKey(request, (auth) => handlePost(request, auth));
  } catch (error) {
    logger.error('MCP transport: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return handleAPIError(error);
  }
}

/** The JSON-RPC request, run inside the key's org scope. */
async function handlePost(request: NextRequest, auth: McpAuthContext): Promise<Response> {
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

  const rateLimiter = getMcpRateLimiter();

  // 4. `initialize` must be alone in a batch.
  //
  // Not a session rule — there is no session state to make ambiguous. Every
  // request in a batch takes its protocol version from the
  // `MCP-Protocol-Version` header, which is absent on a handshake request, so a
  // `[initialize, tools/list]` batch would serve the `tools/list` at
  // `2024-11-05` even though the `initialize` beside it negotiated `2025-06-18`
  // microseconds earlier — silently dropping the tool annotations gated on
  // `>= 2025-06-18`.
  //
  // Cheap to keep: spec revision 2025-06-18 removed JSON-RPC batching, and a
  // 2026-07-28 client sends no `initialize` at all.
  const hasInitialize = validRequests.some((r) => r.method === 'initialize');
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

  // 5. Dispatch each request
  //
  // A stray `Mcp-Session-Id` on the way in is never read, which is what the
  // 2026-07-28 revision asks for: a server should IGNORE the legacy session
  // headers, not refuse the request carrying them. Nothing is sent back either
  // — the Streamable HTTP transport says a client sends the header only if the
  // server issued one, so withholding it is what keeps a client from quoting an
  // id nothing can look up.
  const handlerContext = {
    auth,
    protocolVersion: declaredProtocolVersion(request),
    serverState,
    rateLimiter,
  };
  const responses: (JsonRpcResponse | null)[] = [];

  for (const rpcRequest of validRequests) {
    responses.push(await handleMcpRequest(rpcRequest, handlerContext));
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

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
}

/**
 * GET and DELETE: 405, unconditionally.
 *
 * 405 rather than 404 or 501 because it is the status the Streamable HTTP
 * transport designates for a server offering no GET stream, and the one clients
 * special-case as "no SSE here, carry on" instead of surfacing a transport error
 * on every healthy connect. Revision 2026-07-28 makes it explicit: a
 * modern-only server answers GET and DELETE with 405.
 *
 * **No authentication, no server-enabled check and no audit row** (§39 t-718).
 * Both used to run the full bearer path first, so an unauthenticated GET got a
 * 401 and a disabled server a 503, and a stateless DELETE wrote an audit row
 * recording what the key had asked for. All three are gone deliberately: there
 * is no session in any configuration of this server, so these verbs are not
 * conditionally unavailable — they do not exist, and saying so costs no database
 * lookup and reveals nothing an `Allow` header does not. The audit trail loses
 * the "a client is still trying to terminate sessions" signal; a client sending
 * DELETE is reading an `Mcp-Session-Id` this server never issued, which is a
 * client bug rather than an operator one.
 *
 * `_request` is unread on purpose: nothing about the request can change the
 * answer. That is the point of the header being unconditional.
 */
export function GET(_request: NextRequest): Response {
  return new Response(null, { status: 405, headers: METHOD_NOT_ALLOWED_HEADERS });
}

export function DELETE(_request: NextRequest): Response {
  return new Response(null, { status: 405, headers: METHOD_NOT_ALLOWED_HEADERS });
}
