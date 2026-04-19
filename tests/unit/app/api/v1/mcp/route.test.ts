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

vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn(
    () =>
      new Response('data: connected\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
  ),
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

  it('returns 401 when authentication fails', async () => {
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Unauthorized');
  });

  it('returns 503 when MCP server is disabled', async () => {
    vi.mocked(getMcpServerConfig).mockResolvedValue({
      ...mockServerState,
      isEnabled: false,
    } as never);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('disabled');
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

  it('returns 401 when authentication fails', async () => {
    vi.mocked(authenticateMcpRequest).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Unauthorized');
  });

  it('returns 400 when session header is missing', async () => {
    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Missing Mcp-Session-Id');
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

  it('returns 404 when session belongs to a different api key', async () => {
    mockSessionManager.getSession.mockReturnValue({
      ...mockSession,
      apiKeyId: 'different-key',
    });

    const response = await DELETE(makeDeleteRequest({ [MCP_SESSION_HEADER]: mockSession.id }));

    expect(response.status).toBe(404);
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
});
