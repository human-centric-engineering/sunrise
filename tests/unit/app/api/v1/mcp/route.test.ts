/**
 * Tests: MCP Transport Endpoint
 *
 * POST   /api/v1/mcp — JSON-RPC 2.0 requests
 * GET    /api/v1/mcp — SSE notification stream
 * DELETE /api/v1/mcp — Session termination
 *
 * **`@/lib/env` is mocked, and that is load-bearing.** `vitest.config.ts` runs
 * on `happy-dom`, so `typeof window !== 'undefined'` is true and `lib/env.ts`
 * validates only the *client* schema — every server variable reads as
 * `undefined` here. Without this mock `MCP_SESSION_MODE` is undefined,
 * `isStateless()` is silently false, and the whole stateless path tests as if it
 * were the stateful one. That is not a hypothetical: a downstream
 * implementation of this feature had 40 tests pass over a branch none of them
 * entered, for exactly this reason. Set `mockEnv.MCP_SESSION_MODE` per block.
 *
 * A mock cannot tell you what the SHIPPED default is, though — for that see
 * `tests/unit/lib/env-server-vars.test.ts`, which reads the real schema under
 * the node environment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { JsonRpcErrorCode } from '@/types/mcp';

// ─── Module mocks ───────────────────────────────────────────────────────

const mockSession = {
  id: 'session-abc',
  apiKeyId: 'key-1',
  initialized: false,
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
};

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
  maxSessionsPerKey: 5,
  sessionTtlSeconds: 3600,
  allowedOrigins: [],
  rateLimit: 60,
};

const mockSessionManager = {
  createSession: vi.fn(() => mockSession),
  getSession: vi.fn(() => mockSession),
  destroySession: vi.fn(() => true),
  markInitialized: vi.fn(),
  registerSseListener: vi.fn(),
  unregisterSseListener: vi.fn(),
};

const mockRateLimiter = {
  check: vi.fn(() => ({ success: true, remaining: 59 })),
};

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

/**
 * Mutable so a block can choose its session mode; the route reads it per request.
 * `vi.hoisted` because a `vi.mock` factory is lifted above normal declarations.
 *
 * `NODE_ENV` rides along because this mock replaces `@/lib/env` for EVERY
 * importer in the graph, and `lib/api/errors.ts` branches on it to decide how
 * much detail to leak — leaving it undefined would quietly put the error path in
 * non-production mode for these tests.
 */
const mockEnv = vi.hoisted(() => ({
  MCP_SESSION_MODE: 'stateful',
  NODE_ENV: 'test',
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

// Capture the iterable passed to sseResponse so tests can consume the generator
let capturedIterable: AsyncIterable<{ type: string; data?: string }> | null = null;

vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn((iterable: AsyncIterable<{ type: string; data?: string }>) => {
    capturedIterable = iterable;
    return new Response('data: connected\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }),
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
  getMcpSessionManager: vi.fn(() => mockSessionManager),
  getMcpRateLimiter: vi.fn(() => mockRateLimiter),
  logMcpAudit: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import {
  authenticateMcpRequest,
  getMcpServerConfig,
  handleMcpRequest,
  getMcpSessionManager,
  logMcpAudit,
} from '@/lib/orchestration/mcp';
import { sseResponse } from '@/lib/api/sse';
import { POST, GET, DELETE } from '@/app/api/v1/mcp/route';
import { logger } from '@/lib/logging';
import { getTenantContext, type TenantContext } from '@/lib/tenancy/context';

// ─── Helpers ────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3000/api/v1/mcp';
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
    headers: {
      Authorization: BEARER,
      ...headers,
    },
  });
}

function makeDeleteRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(BASE_URL, {
    method: 'DELETE',
    headers: {
      Authorization: BEARER,
      ...headers,
    },
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
  capturedIterable = null;

  // Reset the mode globally, not per-block: `clearAllMocks` does not touch a
  // plain object, so one block switching to stateless would silently govern
  // every block after it — and they would still pass, because most assertions
  // do not distinguish the modes.
  mockEnv.MCP_SESSION_MODE = 'stateful';

  // Restore default mock behaviours
  vi.mocked(authenticateMcpRequest).mockResolvedValue(mockAuthContext);
  vi.mocked(getMcpServerConfig).mockResolvedValue(mockServerState as never);
  vi.mocked(handleMcpRequest).mockResolvedValue({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [] },
  });
  mockSessionManager.createSession.mockReturnValue(mockSession);
  mockSessionManager.getSession.mockReturnValue(mockSession);
  mockSessionManager.destroySession.mockReturnValue(true);
  vi.mocked(getMcpSessionManager).mockReturnValue(mockSessionManager as never);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST tests
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /mcp — the org an unhandled error is logged in (§108 t-714)', () => {
  it('logs a handler failure INSIDE the key’s org', async () => {
    // withMcpKey enters the org and each verb's outer catch sits outside it,
    // so before this an org's MCP 500 was stamped with no org — and once the
    // admin Logs page is scoped to the reading org, the org whose call failed
    // is the one org that cannot see it.
    vi.mocked(handleMcpRequest).mockRejectedValueOnce(new Error('tool dispatch blew up'));

    const loggedIn: (string | null)[] = [];
    vi.mocked(logger.error).mockImplementation(() => {
      loggedIn.push(getTenantContext()?.orgId ?? null);
    });

    // `initialize` rather than `tools/list`: a non-initialize method needs a
    // session header in stateful mode and is refused at 400 before dispatch,
    // which would have made this test green without ever reaching the catch.
    const response = await POST(makePostRequest(makeRpcRequest('initialize')));

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

    const response = await POST(makePostRequest(makeRpcRequest('initialize')));

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

  it('returns 400 when no session header and method is not initialize', async () => {
    // Covered by another test; this version adds explicit header verification
    const response = await POST(makePostRequest(makeRpcRequest('resources/list')));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('Missing Mcp-Session-Id');
  });

  it('returns 400 for invalid JSON body', async () => {
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: BEARER,
      },
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

  it('creates a new session and returns session id header for initialize', async () => {
    const response = await POST(makePostRequest(makeRpcRequest('initialize')));

    expect(response.status).toBe(200);
    expect(response.headers.get(MCP_SESSION_HEADER)).toBe(mockSession.id);
    expect(mockSessionManager.createSession).toHaveBeenCalledOnce();
  });

  it('mints the session INSIDE the key’s org scope (§108 t-716)', async () => {
    // The wiring half of the stamp. `createSession` reads the org from the
    // tenant context rather than taking it as an argument (the mislabel rule
    // t-714 set for `addLogEntry`), so what has to be true here is that the
    // transport has already entered the key's org by the time it is called.
    // The manager's own tests prove the stamp given a scope; this proves the
    // scope. Neither alone is the property, and the manager is mocked in this
    // file so the stamp itself is not observable here.
    let orgAtCall: string | null | undefined;
    mockSessionManager.createSession.mockImplementation(() => {
      orgAtCall = getTenantContext()?.orgId ?? null;
      return mockSession;
    });

    await POST(makePostRequest(makeRpcRequest('initialize')));

    expect(orgAtCall).toBe(mockAuthContext.orgId);
    // Not merely "some org": the key's own, and mockAuthContext.orgId is
    // deliberately not the install org, so a fallback would read differently.
    expect(orgAtCall).not.toBeNull();
  });

  it('returns 429 when max sessions exceeded on initialize', async () => {
    mockSessionManager.createSession.mockReturnValue(null as never);

    const response = await POST(makePostRequest(makeRpcRequest('initialize')));

    expect(response.status).toBe(429);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('Max sessions exceeded');
  });

  it('returns 404 when session not found for non-initialize request', async () => {
    mockSessionManager.getSession.mockReturnValue(null as never);

    const response = await POST(
      makePostRequest(makeRpcRequest('tools/list'), {
        [MCP_SESSION_HEADER]: 'unknown-session',
      })
    );

    expect(response.status).toBe(404);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('Session not found or expired');
  });

  it('returns 400 when no session header for non-initialize request', async () => {
    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('Missing Mcp-Session-Id');
  });

  it('dispatches request and returns response for known session', async () => {
    const expectedResult = { tools: [{ name: 'search' }] };
    vi.mocked(handleMcpRequest).mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: expectedResult,
    });

    const response = await POST(
      makePostRequest(makeRpcRequest('tools/list'), {
        [MCP_SESSION_HEADER]: mockSession.id,
      })
    );

    expect(response.status).toBe(200);
    const body = await parseJson<{ result: typeof expectedResult }>(response);
    expect(body.result).toEqual(expectedResult);
  });

  it('marks session initialized after successful initialize', async () => {
    await POST(makePostRequest(makeRpcRequest('initialize')));

    expect(mockSessionManager.markInitialized).toHaveBeenCalledWith(mockSession.id);
  });

  it('does not mark session initialized when initialize returns error', async () => {
    vi.mocked(handleMcpRequest).mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      error: { code: JsonRpcErrorCode.INTERNAL_ERROR, message: 'Failed' },
    });

    await POST(makePostRequest(makeRpcRequest('initialize')));

    expect(mockSessionManager.markInitialized).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('returns 204 for notification (handler returns null)', async () => {
    vi.mocked(handleMcpRequest).mockResolvedValue(null);

    const response = await POST(
      makePostRequest(makeRpcRequest('notifications/ping'), {
        [MCP_SESSION_HEADER]: mockSession.id,
      })
    );

    expect(response.status).toBe(204);
  });

  it('handles batch requests and returns array of responses', async () => {
    vi.mocked(handleMcpRequest).mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });

    const response = await POST(
      makePostRequest([makeRpcRequest('tools/list', {}, 1), makeRpcRequest('tools/list', {}, 2)], {
        [MCP_SESSION_HEADER]: mockSession.id,
      })
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
      makePostRequest(
        [makeRpcRequest('notifications/ping', {}, 1), makeRpcRequest('notifications/pong', {}, 2)],
        { [MCP_SESSION_HEADER]: mockSession.id }
      )
    );

    expect(response.status).toBe(204);
  });

  it('returns 404 when session apiKeyId does not match auth apiKeyId', async () => {
    mockSessionManager.getSession.mockReturnValue({
      ...mockSession,
      apiKeyId: 'different-key',
    });

    const response = await POST(
      makePostRequest(makeRpcRequest('tools/list'), {
        [MCP_SESSION_HEADER]: mockSession.id,
      })
    );

    expect(response.status).toBe(404);
  });

  // SOURCE DECISION: Document — branch needs integration test coverage.
  // jsdom strips 'content-length' from NextRequest when the declared size doesn't match
  // the actual body length (Fetch spec "forbidden header" behaviour). The source at
  // app/api/v1/mcp/route.ts:72-82 is correct — it reads the header the real HTTP server
  // populates — but jsdom returns null for this header in unit tests, making the 413
  // branch unreachable. Covered at the integration/e2e layer instead. See
  // `.context/orchestration/mcp.md` → "Body size limit (413)".
  it.todo(
    'returns 413 when content-length exceeds 1MB — integration-only (see .context/orchestration/mcp.md)'
  );

  it('returns 400 when initialize is sent with an existing session header', async () => {
    const response = await POST(
      makePostRequest(makeRpcRequest('initialize'), {
        [MCP_SESSION_HEADER]: mockSession.id,
      })
    );

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: number; message: string } }>(response);
    expect(body.error.message).toBe('Cannot send initialize with an existing session header');
    expect(body.error.code).toBe(JsonRpcErrorCode.INVALID_REQUEST);
  });

  it('returns 400 when batch contains initialize alongside other requests', async () => {
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
  });

  it('filters null responses from batch so only non-notification results are returned', async () => {
    vi.mocked(handleMcpRequest)
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: {} })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 3, result: {} });

    const response = await POST(
      makePostRequest(
        [
          makeRpcRequest('tools/list', {}, 1),
          makeRpcRequest('notifications/ping', {}, 2),
          makeRpcRequest('tools/list', {}, 3),
        ],
        { [MCP_SESSION_HEADER]: mockSession.id }
      )
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
    const { logger } = await import('@/lib/logging');
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
// GET tests
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /mcp', () => {
  it('returns 401 JSON-RPC error when authentication fails', async () => {
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: number; message: string } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.UNAUTHORIZED);
    expect(body.error.message).toBe('Unauthorized');
  });

  it('returns 503 JSON-RPC error when MCP server is disabled', async () => {
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      ...mockServerState,
      isEnabled: false,
    } as never);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(503);
    const body = await parseJson<{ error: { code: number; message: string } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.SERVER_DISABLED);
    expect(body.error.message).toContain('disabled');
  });

  it('returns SSE stream for authenticated request', async () => {
    const { sseResponse } = await import('@/lib/api/sse');

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    expect(sseResponse).toHaveBeenCalledOnce();
  });

  it('passes an async iterable to sseResponse', async () => {
    const { sseResponse } = await import('@/lib/api/sse');

    await GET(makeGetRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    // sseResponse should receive an async iterable (the notification stream generator)
    expect(sseResponse).toHaveBeenCalledOnce();
    const [iterable] = vi.mocked(sseResponse).mock.calls[0];
    expect(iterable).toBeDefined();
    expect(typeof (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');
  });

  it('SSE generator yields connected event and processes notifications', async () => {
    // Capture the notification callback registered by the generator
    let notificationCallback: ((notification: unknown) => void) | null = null;
    mockSessionManager.registerSseListener.mockImplementation(
      (_id: string, cb: (notification: unknown) => void) => {
        notificationCallback = cb;
      }
    );

    const controller = new AbortController();
    const request = new NextRequest(BASE_URL, {
      method: 'GET',
      headers: {
        Authorization: BEARER,
        [MCP_SESSION_HEADER]: mockSession.id,
      },
      signal: controller.signal,
    });

    await GET(request);

    // The mock captures the generator but doesn't iterate it — start manually
    expect(capturedIterable).not.toBeNull();
    const iterator = capturedIterable![Symbol.asyncIterator]();

    // First next() starts the generator body → yields 'connected'
    const first = await iterator.next();
    expect(first.value).toEqual({ type: 'connected' });

    // Second next() continues execution: registers SSE listener, enters while loop,
    // and awaits the queue promise. Don't await yet — it suspends at the promise.
    const secondP = iterator.next();

    // By now registerSseListener has been called synchronously
    expect(notificationCallback).not.toBeNull();
    notificationCallback!({ jsonrpc: '2.0', method: 'test', params: {} });

    // The queued notification resolves the while-loop yield
    const second = await secondP;
    expect(second.value).toEqual({
      type: 'notification',
      data: expect.stringContaining('"method":"test"'),
    });

    // Abort to stop the generator — start next() then abort
    const finalP = iterator.next();
    controller.abort();
    const final = await finalP;
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(final.done).toBe(true);

    // Verify cleanup
    expect(mockSessionManager.unregisterSseListener).toHaveBeenCalledWith(mockSession.id);
  });

  it('SSE generator stops when request is aborted while waiting', async () => {
    const controller = new AbortController();
    const request = new NextRequest(BASE_URL, {
      method: 'GET',
      headers: {
        Authorization: BEARER,
        [MCP_SESSION_HEADER]: mockSession.id,
      },
      signal: controller.signal,
    });

    await GET(request);

    expect(capturedIterable).not.toBeNull();
    const iterator = capturedIterable![Symbol.asyncIterator]();

    // Consume the 'connected' event (starts generator body)
    await iterator.next();

    // Start next iteration (generator enters while loop, awaits queue promise)
    const nextP = iterator.next();

    // Abort while generator is waiting for notifications
    controller.abort();
    const result = await nextP;
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(result.done).toBe(true);
  });

  it('SSE generator does not register listener when no session header', async () => {
    const controller = new AbortController();
    const request = new NextRequest(BASE_URL, {
      method: 'GET',
      headers: {
        Authorization: BEARER,
      },
      signal: controller.signal,
    });

    await GET(request);

    expect(capturedIterable).not.toBeNull();
    const iterator = capturedIterable![Symbol.asyncIterator]();

    // Consume connected event (starts generator body)
    await iterator.next();

    // Start next iteration to execute the registerSseListener path
    const nextP = iterator.next();

    // No session header → registerSseListener should NOT be called
    expect(mockSessionManager.registerSseListener).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;

    // Abort to clean up
    controller.abort();
    await nextP;
  });

  it('returns error response when getMcpServerConfig throws', async () => {
    vi.mocked(getMcpServerConfig).mockRejectedValue(new Error('db failure'));

    const response = await GET(makeGetRequest());

    // handleAPIError handles the thrown error — not an SSE stream
    expect(response.status).not.toBe(200);
    expect(response.headers.get('Content-Type')).not.toContain('text/event-stream');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE tests
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /mcp — whose stream the caller may attach to (§108 t-716)', () => {
  // A session id is not a capability; the key is. POST and DELETE have always
  // re-checked that a named session belongs to the authenticated key, and this
  // path — the one that attaches a LISTENER — did not. With any valid MCP key a
  // caller could open GET with another key's session id and receive that
  // session's `notifications/message`, `resources/updated` and `progress`
  // pushes, while the rightful owner silently stopped receiving them, because
  // `sseListeners` is keyed by session id and the second registration replaces
  // the first.
  //
  // Scoping who a notification is ADDRESSED to is worth nothing while the sink
  // for an address can belong to someone else, which is why this sits in t-716
  // rather than in a follow-up.

  it('refuses another key’s session with 404 and attaches nothing', async () => {
    vi.mocked(mockSessionManager.getSession).mockReturnValue({
      ...mockSession,
      apiKeyId: 'a-different-key',
    });

    const response = await GET(makeGetRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    expect(response.status).toBe(404);
    const body = await parseJson<{ error: { code: number } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.SESSION_NOT_FOUND);
    // No STREAM was opened — asserted on `sseResponse`, not on
    // `registerSseListener`. The first version of this test asserted the
    // listener was not registered and could not fail: `registerSseListener`
    // runs inside the async generator, which `sseResponse` is mocked to capture
    // without iterating, so it is never called in a test that does not drive it
    // by hand — including on the success path. The `no_arg_called` suppression I
    // put on it hid exactly that.
    expect(sseResponse).not.toHaveBeenCalled();
    expect(capturedIterable).toBeNull();
  });

  it('refuses an unknown session the same way, so the two are indistinguishable', async () => {
    vi.mocked(mockSessionManager.getSession).mockReturnValue(null as never);

    const foreign = await GET(makeGetRequest({ [MCP_SESSION_HEADER]: mockSession.id }));
    const unknown = await GET(makeGetRequest({ [MCP_SESSION_HEADER]: 'no-such-session' }));

    expect(foreign.status).toBe(unknown.status);
    expect(await parseJson<{ error: { code: number } }>(foreign)).toEqual(
      await parseJson<{ error: { code: number } }>(unknown)
    );
  });

  it('attaches for the caller’s own session', async () => {
    // The population check, and it has to drive the generator to be one: the
    // refusals above would pass for free if GET never attached a listener at
    // all, so this asserts the sink really is registered for a legitimate
    // caller. Two `next()` calls, the same way the other GET tests reach it —
    // the first yields `connected`, the second runs as far as
    // `registerSseListener` and then parks on the queue.
    vi.mocked(mockSessionManager.getSession).mockReturnValue(mockSession);

    const response = await GET(makeGetRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    expect(response.status).toBe(200);
    expect(capturedIterable).not.toBeNull();
    const iterator = capturedIterable![Symbol.asyncIterator]();
    await iterator.next();
    void iterator.next();

    expect(mockSessionManager.registerSseListener).toHaveBeenCalledWith(
      mockSession.id,
      expect.any(Function)
    );
  });
});

describe('DELETE /mcp', () => {
  it('returns 401 JSON-RPC error when authentication fails', async () => {
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: number; message: string } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.UNAUTHORIZED);
    expect(body.error.message).toBe('Unauthorized');
  });

  it('returns 400 JSON-RPC error when session header is missing', async () => {
    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: number; message: string } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.INVALID_REQUEST);
    expect(body.error.message).toContain('Missing Mcp-Session-Id');
  });

  it('returns 204 when session is successfully destroyed', async () => {
    mockSessionManager.getSession.mockReturnValue(mockSession);
    mockSessionManager.destroySession.mockReturnValue(true);

    const response = await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    expect(response.status).toBe(204);
    expect(mockSessionManager.destroySession).toHaveBeenCalledWith(mockSession.id);
  });

  it('returns 404 when session does not exist', async () => {
    mockSessionManager.getSession.mockReturnValue(null as never);

    const response = await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: 'unknown-session' }));

    expect(response.status).toBe(404);
  });

  it('returns 404 JSON-RPC error when session belongs to a different api key', async () => {
    mockSessionManager.getSession.mockReturnValue({
      ...mockSession,
      apiKeyId: 'different-key',
    });

    const response = await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    expect(response.status).toBe(404);
    const body = await parseJson<{ error: { code: number; message: string } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.SESSION_NOT_FOUND);
    expect(body.error.message).toBe('Session not found');
  });

  it('calls logMcpAudit after session destroy', async () => {
    mockSessionManager.getSession.mockReturnValue(mockSession);
    mockSessionManager.destroySession.mockReturnValue(true);

    await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    expect(logMcpAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: mockAuthContext.apiKeyId,
        method: 'session/destroy',
        responseCode: 'success',
      })
    );
  });

  it('logs error audit when session not found', async () => {
    mockSessionManager.getSession.mockReturnValue(null as never);

    await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: 'nonexistent' }));

    expect(logMcpAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        responseCode: 'error',
        errorMessage: 'Session not found',
      })
    );
  });

  it('does not call destroySession when session belongs to a different api key', async () => {
    mockSessionManager.getSession.mockReturnValue({
      ...mockSession,
      apiKeyId: 'different-key',
    });

    await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    expect(mockSessionManager.destroySession).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('returns error response when getMcpSessionManager throws', async () => {
    vi.mocked(getMcpSessionManager).mockImplementation(() => {
      throw new Error('session manager failure');
    });

    const response = await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    // handleAPIError handles the thrown error — not a success response
    expect(response.status).not.toBe(200);
    expect(response.status).not.toBe(204);
  });
});

// ─── MCP_SESSION_MODE=stateless (#609) ──────────────────────────────────

describe('stateless mode', () => {
  beforeEach(() => {
    mockEnv.MCP_SESSION_MODE = 'stateless';
  });

  it('serves a request with no session header, where stateful rejects it', () => {
    // The pair is the point. The identical request 400s in stateful mode (see
    // "Missing Mcp-Session-Id header" above) — that is the bug on serverless,
    // where `initialize` lands on one instance and this lands on another.
    return POST(makePostRequest(makeRpcRequest('tools/list'))).then(async (res) => {
      expect(res.status).toBe(200);
      expect(handleMcpRequest).toHaveBeenCalled();
    });
  });

  it('issues no Mcp-Session-Id, so the client never sends one back', async () => {
    const res = await POST(makePostRequest(makeRpcRequest('tools/list')));

    // The status assertion is load-bearing: in stateful mode this same request
    // 400s, and an error response carries no session header either — so without
    // it the test would pass in both modes for different reasons.
    expect(res.status).toBe(200);
    // Per the Streamable HTTP transport a client sends the header only if the
    // server issued one. Withholding it is what makes the round trip work.
    expect(res.headers.get(MCP_SESSION_HEADER)).toBeNull();
  });

  it('ignores a stale session id instead of 404ing it', async () => {
    // A leftover id from a previous stateful deploy, or from a sibling instance.
    const res = await POST(
      makePostRequest(makeRpcRequest('tools/list'), {
        [MCP_SESSION_HEADER]: 'session-from-elsewhere',
      })
    );

    expect(res.status).toBe(200);
    expect(mockSessionManager.getSession).not.toHaveBeenCalled();
  });

  it('never touches the session manager — nothing to create, persist or evict', async () => {
    await POST(makePostRequest(makeRpcRequest('initialize')));

    expect(mockSessionManager.createSession).not.toHaveBeenCalled();
    expect(mockSessionManager.markInitialized).not.toHaveBeenCalled();
  });

  it('hands the handler a session flagged ephemeral', async () => {
    await POST(makePostRequest(makeRpcRequest('tools/list')));

    const [, context] = vi.mocked(handleMcpRequest).mock.calls[0];
    expect(context.session.ephemeral).toBe(true);
    expect(context.session.initialized).toBe(true);
  });

  it('rejects a batched initialize here too, not just in stateful mode', async () => {
    // Stateless has no session state to make ambiguous, but it has the subtler
    // version: every request in the batch takes its version from the
    // `MCP-Protocol-Version` header, absent on a handshake request — so the
    // `tools/list` would be served at 2024-11-05 while the `initialize` beside
    // it negotiated 2025-06-18, silently dropping the annotations gated on
    // `>= 2025-06-18`. Same guard, both modes, rather than a documented
    // difference.
    const res = await POST(
      makePostRequest([makeRpcRequest('initialize'), makeRpcRequest('tools/list', undefined, 2)])
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('initialize must be the only request in the batch');
    expect(handleMcpRequest).not.toHaveBeenCalled();
  });

  it('answers GET with 405 and Allow: POST, not a broken SSE stream', async () => {
    const res = await GET(makeGetRequest());

    // 405 is the status the transport designates for "no GET stream here", and
    // the one clients treat as informational rather than as a failed connect.
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(JsonRpcErrorCode.STATELESS_UNSUPPORTED);
  });

  it('still answers an UNAUTHENTICATED GET with 401, not 405', async () => {
    // Pins the position of the stateless block inside GET. It sits after auth
    // and after the server-enabled check deliberately, so the method is only
    // unavailable to callers who would otherwise have been allowed it — but
    // nothing tested that, and hoisting the block to the top of the handler
    // passed the whole suite.
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(401);
  });

  it('still answers GET with 503 when the MCP server is disabled', async () => {
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      ...mockServerState,
      isEnabled: false,
    } as never);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(503);
  });

  it('answers DELETE with 405 but still audits what the key asked for', async () => {
    const res = await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: 'whatever' }));

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    expect(logMcpAudit).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session/destroy', responseCode: 'error' })
    );
  });
});

describe('stateless mode: the protocol version comes from the header', () => {
  beforeEach(() => {
    mockEnv.MCP_SESSION_MODE = 'stateless';
  });

  async function versionSeenByHandler(headers: Record<string, string> = {}): Promise<string> {
    await POST(makePostRequest(makeRpcRequest('tools/list'), headers));
    const [, context] = vi.mocked(handleMcpRequest).mock.calls[0];
    return context.session.protocolVersion;
  }

  it('honours a version the server supports', async () => {
    expect(await versionSeenByHandler({ 'mcp-protocol-version': '2025-06-18' })).toBe('2025-06-18');
  });

  it('falls back to the OLDEST when the header is missing', async () => {
    // No session remembers a negotiation, so the conservative read is that the
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
    expect(await versionSeenByHandler({ 'mcp-protocol-version': '2026-07-28' })).toBe('2025-06-18');
    expect(await versionSeenByHandler({ 'mcp-protocol-version': '2025-11-25' })).toBe('2025-06-18');
  });

  it('falls back to the oldest for a BACK-dated or junk value', async () => {
    // The other side of the same rule: older-unknown and malformed are not
    // evidence of a newer client, so they get the conservative floor.
    expect(await versionSeenByHandler({ 'mcp-protocol-version': '1999-01-01' })).toBe('2024-11-05');
    expect(await versionSeenByHandler({ 'mcp-protocol-version': 'banana' })).toBe('2024-11-05');
  });
});

describe('the org the key acts for (§106, t-673)', () => {
  // Each method runs its handler inside the key's org — asserted from inside
  // the first thing the handler does, not from the arguments anything was
  // called with — and nothing leaks past the response.
  const IN_ORG = { orgId: mockAuthContext.orgId, source: 'mcp-key', role: undefined };

  it('POST: the JSON-RPC dispatch sees the key’s org', async () => {
    let seen: TenantContext | null | undefined;
    vi.mocked(handleMcpRequest).mockImplementation((async () => {
      seen = getTenantContext();
      return { jsonrpc: '2.0', id: 1, result: {} };
    }) as never);

    const response = await POST(
      makePostRequest(makeRpcRequest('tools/list'), { [MCP_SESSION_HEADER]: mockSession.id })
    );

    expect(response.status).toBe(200);
    expect(seen).toEqual(IN_ORG);
    expect(getTenantContext()).toBeNull();
  });

  it('GET: the stream is opened inside the key’s org', async () => {
    let seen: TenantContext | null | undefined;
    vi.mocked(getMcpServerConfig).mockImplementation((async () => {
      seen = getTenantContext();
      return mockServerState;
    }) as never);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    expect(seen).toEqual(IN_ORG);
    expect(getTenantContext()).toBeNull();
  });

  it('DELETE: the session lookup and the audit row see the key’s org', async () => {
    let seen: TenantContext | null | undefined;
    mockSessionManager.getSession.mockImplementation(() => {
      seen = getTenantContext();
      return mockSession;
    });
    mockSessionManager.destroySession.mockReturnValue(true);

    const response = await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    expect(response.status).toBe(204);
    expect(seen).toEqual(IN_ORG);
    expect(getTenantContext()).toBeNull();
  });

  it('a key that cannot enter its org is a 401 before any handler runs', async () => {
    // `authenticateMcpRequest` answers null for a suspended org or a null-org
    // key at multi (its own tests); the transport treats that as no key.
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);
    for (const call of [
      () => POST(makePostRequest(makeRpcRequest('tools/list'))),
      () => GET(makeGetRequest()),
      () => DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: mockSession.id })),
    ]) {
      expect((await call()).status).toBe(401);
    }
    expect(handleMcpRequest).not.toHaveBeenCalled();
    expect(getMcpServerConfig).not.toHaveBeenCalled();
    expect(mockSessionManager.getSession).not.toHaveBeenCalled();
  });
});
