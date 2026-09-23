/**
 * Tests: MCP Transport Endpoint
 *
 * POST   /api/v1/mcp — JSON-RPC 2.0 requests, the only method this server has
 * GET    /api/v1/mcp — 405, `Allow: POST`
 * DELETE /api/v1/mcp — 405, `Allow: POST`
 *
 * **This file used to mock `@/lib/env`, and the mock was load-bearing** — it set
 * `MCP_SESSION_MODE` per block, because under `happy-dom` every server variable
 * reads as `undefined` and the stateless branch would have tested as the
 * stateful one. Both halves of that are gone: the route reads no environment
 * variable now (§39 t-718), and this file runs under `node`, where the real
 * server schema loads. What the mock was protecting against is recorded in
 * `tests/unit/lib/env-server-vars.test.ts` and
 * `.context/testing/environments.md`.
 *
 * @see app/api/v1/mcp/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { JsonRpcErrorCode, MCP_LATEST_PROTOCOL_VERSION } from '@/types/mcp';

// ─── Module mocks ───────────────────────────────────────────────────────

const mockAuthContext = {
  apiKeyId: 'key-1',
  apiKeyName: 'Test Key',
  scopes: ['tools:list', 'tools:execute'],
  createdBy: 'admin-1',
  clientIp: '127.0.0.1',
  userAgent: 'test-agent',
  scopedAgentId: null,
  orgId: 'cmorg000000000000000other',
};

const mockServerState = {
  id: 'config-1',
  isEnabled: true,
  serverName: 'Sunrise MCP',
  serverVersion: '1.0.0',
  sessionTtlSeconds: 3600,
  allowedOrigins: [],
  rateLimit: 60,
};

const mockRateLimiter = {
  check: vi.fn(() => ({ success: true, remaining: 59 })),
};

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/mcp', () => ({
  authenticateMcpRequest: vi.fn(async () => mockAuthContext),
  getMcpServerConfig: vi.fn(async () => mockServerState),
  handleMcpRequest: vi.fn(async () => ({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [] },
  })),
  getMcpRateLimiter: vi.fn(() => mockRateLimiter),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import {
  authenticateMcpRequest,
  getMcpServerConfig,
  handleMcpRequest,
} from '@/lib/orchestration/mcp';
import { POST, GET, DELETE } from '@/app/api/v1/mcp/route';
import { logger } from '@/lib/logging';
import { getTenantContext, type TenantContext } from '@/lib/tenancy/context';

// ─── Helpers ────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3000/api/v1/mcp';
/** Lower-cased, the way the route reads it — and the header nothing issues now. */
const MCP_SESSION_HEADER = 'mcp-session-id';
const BEARER = 'Bearer test-api-key';

function makePostRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: BEARER,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers: { Authorization: BEARER, ...headers },
  });
}

function makeDeleteRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(BASE_URL, {
    method: 'DELETE',
    headers: { Authorization: BEARER, ...headers },
  });
}

function makeRpcRequest(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateMcpRequest).mockResolvedValue(mockAuthContext);
  vi.mocked(getMcpServerConfig).mockResolvedValue(mockServerState as never);
  vi.mocked(handleMcpRequest).mockResolvedValue({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [] },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /mcp — the org an unhandled error is logged in (§108 t-714)', () => {
  it('logs a handler failure INSIDE the key’s org', async () => {
    // withMcpKey enters the org and the outer catch sits outside it, so before
    // this an org's MCP 500 was stamped with no org — and once the admin Logs
    // page is scoped to the reading org, the org whose call failed is the one
    // org that cannot see it.
    vi.mocked(handleMcpRequest).mockRejectedValueOnce(new Error('tool dispatch blew up'));

    const loggedIn: (string | null)[] = [];
    vi.mocked(logger.error).mockImplementation(() => {
      loggedIn.push(getTenantContext()?.orgId ?? null);
    });

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(500);
    expect(loggedIn.length).toBeGreaterThan(0);
    expect(loggedIn.every((orgId) => orgId === mockAuthContext.orgId)).toBe(true);
  });

  it('logs outside any org when the key itself could not be authenticated', async () => {
    // There is genuinely no org yet, so the outer catch is still right there.
    vi.mocked(authenticateMcpRequest).mockRejectedValueOnce(new Error('auth store is down'));

    const loggedIn: (string | null)[] = [];
    vi.mocked(logger.error).mockImplementation(() => {
      loggedIn.push(getTenantContext()?.orgId ?? null);
    });

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(500);
    expect(loggedIn.length).toBeGreaterThan(0);
    expect(loggedIn.every((orgId) => orgId === null)).toBe(true);
  });
});

describe('POST /mcp', () => {
  it('returns 401 JSON-RPC error when authentication fails', async () => {
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: number } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.UNAUTHORIZED);
  });

  it('includes WWW-Authenticate Bearer challenge on 401', async () => {
    // Lets 2025-spec OAuth-capable clients detect that this server is
    // bearer-only and skip the OAuth discovery dance.
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(401);
    const challenge = response.headers.get('WWW-Authenticate');
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain('realm="sunrise-mcp"');
    expect(challenge).toContain('error="invalid_token"');
  });

  it('returns 503 when MCP server is disabled', async () => {
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      ...mockServerState,
      isEnabled: false,
    } as never);

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(503);
    const body = await parseJson<{ error: { code: number; message: string } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.SERVER_DISABLED);
    expect(body.error.message).toContain('disabled');
  });

  it('returns 400 for invalid JSON body', async () => {
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: 'not-valid-json{{{',
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: number } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.PARSE_ERROR);
  });

  it('returns 400 for empty batch array', async () => {
    const response = await POST(makePostRequest([]));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('Empty batch');
  });

  it('returns 400 when batch exceeds max size', async () => {
    const requests = Array.from({ length: 21 }, (_, i) => makeRpcRequest('tools/list', {}, i + 1));

    const response = await POST(makePostRequest(requests));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('Batch too large');
  });

  it('returns 400 for invalid JSON-RPC envelope', async () => {
    const response = await POST(makePostRequest({ notRpc: true }));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: number } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.INVALID_REQUEST);
  });

  it('dispatches a request that carries no session header at all', async () => {
    // The whole shape of the transport in one assertion. This identical request
    // used to 400 with "Missing Mcp-Session-Id header" unless the deploy was
    // explicitly configured stateless — which is the bug that made the stateful
    // transport unusable on any platform serving traffic from more than one
    // process.
    const expectedResult = { tools: [{ name: 'search' }] };
    vi.mocked(handleMcpRequest).mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: expectedResult,
    });

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(200);
    expect(await parseJson<{ result: typeof expectedResult }>(response)).toMatchObject({
      result: expectedResult,
    });
  });

  it('issues no Mcp-Session-Id, so a client never sends one back', async () => {
    // Per the Streamable HTTP transport a client sends the header only if the
    // server issued one. The status assertion is load-bearing: an error response
    // carries no session header either, so without it this would pass for the
    // wrong reason.
    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(200);
    expect(response.headers.get(MCP_SESSION_HEADER)).toBeNull();
  });

  it('IGNORES a stray Mcp-Session-Id rather than refusing the request', async () => {
    // Revision 2026-07-28, verbatim: a server should ignore the legacy session
    // headers, not error on one. A leftover id can arrive from a client that
    // remembers a previous deploy. Both outcomes it used to have are asserted
    // against: the 400 the stateful path gave a request it thought was
    // mid-handshake, and the 404 it gave an id it could not find.
    const response = await POST(
      makePostRequest(makeRpcRequest('tools/list'), {
        [MCP_SESSION_HEADER]: 'session-from-a-previous-deploy',
      })
    );

    expect(response.status).toBe(200);
    expect(handleMcpRequest).toHaveBeenCalledOnce();
  });

  it('ignores a stray Mcp-Session-Id on an `initialize` too', async () => {
    // The other refusal that went: `initialize` carrying a session header used
    // to be a 400, because replaying it was how a client could mint unlimited
    // sessions. There are no sessions to mint.
    const response = await POST(
      makePostRequest(makeRpcRequest('initialize'), { [MCP_SESSION_HEADER]: 'anything' })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(MCP_SESSION_HEADER)).toBeNull();
  });

  it('returns 204 for notification (handler returns null)', async () => {
    vi.mocked(handleMcpRequest).mockResolvedValue(null);

    const response = await POST(makePostRequest(makeRpcRequest('notifications/ping')));

    expect(response.status).toBe(204);
  });

  it('handles batch requests and returns array of responses', async () => {
    vi.mocked(handleMcpRequest).mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} });

    const response = await POST(
      makePostRequest([makeRpcRequest('tools/list', {}, 1), makeRpcRequest('tools/list', {}, 2)])
    );

    expect(response.status).toBe(200);
    const body = await parseJson<unknown[]>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it('returns 204 for batch of all notifications', async () => {
    vi.mocked(handleMcpRequest).mockResolvedValue(null);

    const response = await POST(
      makePostRequest([
        makeRpcRequest('notifications/ping', {}, 1),
        makeRpcRequest('notifications/pong', {}, 2),
      ])
    );

    expect(response.status).toBe(204);
  });

  // SOURCE DECISION: Document — branch needs integration test coverage.
  // jsdom strips 'content-length' from NextRequest when the declared size doesn't match
  // the actual body length (Fetch spec "forbidden header" behaviour). The source is
  // correct — it reads the header the real HTTP server populates — but jsdom returns
  // null for this header in unit tests, making the 413 branch unreachable. Covered at
  // the integration/e2e layer instead. See `.context/orchestration/mcp.md` → "Body size
  // limit (413)".
  it.todo(
    'returns 413 when content-length exceeds 1MB — integration-only (see .context/orchestration/mcp.md)'
  );

  it('returns 400 when batch contains initialize alongside other requests', async () => {
    // Kept, and it is not a session rule: every request in a batch takes its
    // version from the `MCP-Protocol-Version` header, absent on a handshake
    // request, so the `tools/list` would be served at 2024-11-05 while the
    // `initialize` beside it negotiated 2025-06-18 — silently dropping the tool
    // annotations gated on `>= 2025-06-18`.
    const initRequest = makeRpcRequest('initialize', {}, 42);
    const response = await POST(
      makePostRequest([initRequest, makeRpcRequest('tools/list', {}, 2)])
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ id: number | null; error: { code: number; message: string } }>(
      response
    );
    expect(body.error.message).toBe('initialize must be the only request in the batch');
    expect(body.error.code).toBe(JsonRpcErrorCode.INVALID_REQUEST);
    // id comes from the initialize request in the batch
    expect(body.id).toBe(42);
    expect(handleMcpRequest).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: nothing is dispatched
  });

  it('filters null responses from batch so only non-notification results are returned', async () => {
    vi.mocked(handleMcpRequest)
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: {} })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 3, result: {} });

    const response = await POST(
      makePostRequest([
        makeRpcRequest('tools/list', {}, 1),
        makeRpcRequest('notifications/ping', {}, 2),
        makeRpcRequest('tools/list', {}, 3),
      ])
    );

    expect(response.status).toBe(200);
    const body = await parseJson<{ jsonrpc: string }[]>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].jsonrpc).toBe('2.0');
    expect(body[1].jsonrpc).toBe('2.0');
  });

  it('logs unhandled error and delegates to handleAPIError when authenticateMcpRequest throws', async () => {
    vi.mocked(authenticateMcpRequest).mockRejectedValue(new Error('boom'));

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'MCP transport: unhandled error',
      expect.objectContaining({ error: 'boom' })
    );
    // handleAPIError returns 500 for unknown Error instances
    expect(response.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The protocol version, which is now the only per-request negotiation left
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /mcp: the protocol version comes from the header', () => {
  async function versionSeenByHandler(headers: Record<string, string> = {}): Promise<string> {
    await POST(makePostRequest(makeRpcRequest('tools/list'), headers));
    const [, context] = vi.mocked(handleMcpRequest).mock.calls[0];
    return context.protocolVersion;
  }

  it('honours a version the server supports', async () => {
    expect(await versionSeenByHandler({ 'mcp-protocol-version': '2025-06-18' })).toBe('2025-06-18');
  });

  it('falls back to the OLDEST when the header is missing', async () => {
    // Nothing remembers a negotiation, so the conservative read is that the
    // client predates version negotiation entirely.
    expect(await versionSeenByHandler()).toBe('2024-11-05');
  });

  it('DOWNGRADES a forward-dated client to our latest, rather than flooring it', async () => {
    // The correction that must not be inherited. A `2026-07-28` client
    // understands strictly MORE than we do; flooring it to `2024-11-05` means
    // the newer the client the worse it is treated, and `protocol-handler` gates
    // tool annotations on `>= 2025-06-18` — so the newest clients would silently
    // lose annotations on the default path. `negotiateMcpProtocolVersion`
    // already draws this distinction; the route delegates rather than
    // re-deciding.
    expect(await versionSeenByHandler({ 'mcp-protocol-version': '2026-07-28' })).toBe(
      MCP_LATEST_PROTOCOL_VERSION
    );
    expect(await versionSeenByHandler({ 'mcp-protocol-version': '2025-11-25' })).toBe(
      MCP_LATEST_PROTOCOL_VERSION
    );
  });

  it('falls back to the oldest for a BACK-dated or junk value', async () => {
    // The other side of the same rule: older-unknown and malformed are not
    // evidence of a newer client, so they get the conservative floor.
    expect(await versionSeenByHandler({ 'mcp-protocol-version': '1999-01-01' })).toBe('2024-11-05');
    expect(await versionSeenByHandler({ 'mcp-protocol-version': 'banana' })).toBe('2024-11-05');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET and DELETE — 405, whatever the request says
// ─────────────────────────────────────────────────────────────────────────────

describe('GET and DELETE /mcp answer 405 unconditionally (§39 t-718)', () => {
  // Both handlers are SYNCHRONOUS — no await here, and eslint's
  // `await-thenable` is what says so. Nothing they do can be asynchronous now:
  // they read nothing, look up no key and touch no database.
  const verbs = [
    ['GET', () => GET(makeGetRequest())],
    ['DELETE', () => DELETE(makeDeleteRequest())],
  ] as const;

  it.each(verbs)('%s answers 405 with Allow: POST and an empty body', async (_name, call) => {
    const response = call();

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(await response.text()).toBe('');
  });

  /**
   * The behaviour change worth pinning. Both verbs used to run the full bearer
   * path first: an unauthenticated GET got 401, a disabled server got 503, and a
   * DELETE wrote an audit row for what the key had asked for. Their availability
   * was conditional, so the order mattered. It is not conditional now — there is
   * no session in any configuration — so nothing about the request is read, and
   * the key is never looked up.
   */
  it.each([
    ['GET', () => GET(new NextRequest(BASE_URL, { method: 'GET' }))],
    ['DELETE', () => DELETE(new NextRequest(BASE_URL, { method: 'DELETE' }))],
  ] as const)('%s answers 405 with NO credentials, rather than 401', (_name, call) => {
    const response = call();

    expect(response.status).toBe(405);
    expect(authenticateMcpRequest).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the point is that no key lookup happens
  });

  it.each(verbs)('%s answers 405 even when the MCP server is DISABLED', (_name, call) => {
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      ...mockServerState,
      isEnabled: false,
    } as never);

    const response = call();

    expect(response.status).toBe(405);
    expect(getMcpServerConfig).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the config is never read either
  });

  it('GET answers 405 even carrying a session id and a valid bearer', () => {
    const response = GET(makeGetRequest({ [MCP_SESSION_HEADER]: 'session-abc' }));

    expect(response.status).toBe(405);
  });

  it('DELETE answers 405 even carrying a session id, and audits nothing', () => {
    const response = DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: 'session-abc' }));

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenancy
// ─────────────────────────────────────────────────────────────────────────────

describe('the org the key acts for (§106, t-673)', () => {
  // POST is the only verb that authenticates now, so it is the only one with an
  // org to be in. It runs its handler inside the key's org — asserted from
  // inside the first thing the handler does, not from the arguments anything was
  // called with — and nothing leaks past the response.
  const IN_ORG = { orgId: mockAuthContext.orgId, source: 'mcp-key', role: undefined };

  it('POST: the JSON-RPC dispatch sees the key’s org', async () => {
    let seen: TenantContext | null | undefined;
    vi.mocked(handleMcpRequest).mockImplementation((async () => {
      seen = getTenantContext();
      return { jsonrpc: '2.0', id: 1, result: {} };
    }) as never);

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(200);
    expect(seen).toEqual(IN_ORG);
    expect(getTenantContext()).toBeNull();
  });

  it('POST: the server-config read happens inside the org too', async () => {
    let seen: TenantContext | null | undefined;
    vi.mocked(getMcpServerConfig).mockImplementation((async () => {
      seen = getTenantContext();
      return mockServerState;
    }) as never);

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(200);
    expect(seen).toEqual(IN_ORG);
    expect(getTenantContext()).toBeNull();
  });

  it('a key that cannot enter its org is a 401 before any handler runs', async () => {
    // `authenticateMcpRequest` answers null for a suspended org or a null-org
    // key at multi (its own tests); the transport treats that as no key.
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(401);
    expect(handleMcpRequest).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard
    expect(getMcpServerConfig).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard
  });
});
