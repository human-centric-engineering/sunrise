/**
 * Tests: MCP Transport Endpoint
 *
 * POST   /api/v1/mcp — JSON-RPC 2.0 requests
 * GET    /api/v1/mcp — SSE notification stream
 * DELETE /api/v1/mcp — Session termination
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

vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() => new Response('Rate limited', { status: 429 })),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

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

import { apiLimiter } from '@/lib/security/rate-limit';
import {
  authenticateMcpRequest,
  getMcpServerConfig,
  handleMcpRequest,
  getMcpSessionManager,
  logMcpAudit,
} from '@/lib/orchestration/mcp';
import { POST, GET, DELETE } from '@/app/api/v1/mcp/route';

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

  // Restore default mock behaviours
  vi.mocked(apiLimiter.check).mockReturnValue({ success: true } as never);
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

describe('POST /mcp', () => {
  it('returns 429 when IP rate limit exceeded', async () => {
    vi.mocked(apiLimiter.check).mockReturnValue({ success: false } as never);

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(429);
  });

  it('returns 401 JSON-RPC error when authentication fails', async () => {
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: number } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.INTERNAL_ERROR);
  });

  it('returns 503 when MCP server is disabled', async () => {
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      ...mockServerState,
      isEnabled: false,
    } as never);

    const response = await POST(makePostRequest(makeRpcRequest('tools/list')));

    expect(response.status).toBe(503);
    const body = await parseJson<{ error: { message: string } }>(response);
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

    expect(mockSessionManager.markInitialized).not.toHaveBeenCalled();
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
  it('returns 429 when IP rate limit exceeded', async () => {
    vi.mocked(apiLimiter.check).mockReturnValue({ success: false } as never);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(429);
  });

  it('returns 401 JSON-RPC error when authentication fails', async () => {
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: number; message: string } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.INTERNAL_ERROR);
    expect(body.error.message).toBe('Unauthorized');
  });

  it('returns 503 JSON-RPC error when MCP server is disabled', async () => {
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      ...mockServerState,
      isEnabled: false,
    } as never);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(503);
    const body = await parseJson<{ error: { message: string } }>(response);
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
    expect(mockSessionManager.registerSseListener).not.toHaveBeenCalled();

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

describe('DELETE /mcp', () => {
  it('returns 429 when IP rate limit exceeded', async () => {
    vi.mocked(apiLimiter.check).mockReturnValue({ success: false } as never);

    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(429);
  });

  it('returns 401 JSON-RPC error when authentication fails', async () => {
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(401);
    const body = await parseJson<{ error: { code: number; message: string } }>(response);
    expect(body.error.code).toBe(JsonRpcErrorCode.INTERNAL_ERROR);
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
    expect(body.error.code).toBe(JsonRpcErrorCode.INTERNAL_ERROR);
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

    expect(mockSessionManager.destroySession).not.toHaveBeenCalled();
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
