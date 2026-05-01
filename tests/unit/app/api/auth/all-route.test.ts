/**
 * Unit Tests: app/api/auth/[...all]/route.ts
 *
 * Contract under test:
 * - GET dispatches to the better-auth GET handler and mirrors the response
 * - POST dispatches to the better-auth POST handler and mirrors the response
 * - Errors thrown by the better-auth handler propagate through (are re-thrown)
 * - The route logger is obtained and called for each request/response cycle
 * - Log entries include the authPath derived from the request URL
 *
 * This route is a thin logging wrapper around better-auth's toNextJsHandler.
 * The tests verify the dispatch contract (correct handler called, response
 * mirrored, errors re-thrown) without exercising better-auth internals.
 *
 * @see app/api/auth/[...all]/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- Hoisted declarations (resolved before vi.mock factory bodies run) ---
// vi.mock factories are hoisted to the top of the file by Vitest's transform,
// so any variables they reference must also be hoisted via vi.hoisted().

const { mockBetterAuthGET, mockBetterAuthPOST, mockLog } = vi.hoisted(() => {
  const mockBetterAuthGET = vi.fn();
  const mockBetterAuthPOST = vi.fn();
  const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn(),
  };
  return { mockBetterAuthGET, mockBetterAuthPOST, mockLog };
});

// --- Module mocks (hoisted before any imports) ---

// Mock @/lib/api/context so getRouteLogger returns the controlled logger.
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(),
}));

// Mock better-auth/next-js.  The route calls toNextJsHandler(auth) at module
// scope and destructures { POST, GET } from the result.  We return controlled
// stubs so tests can assert dispatch and response mirroring.
vi.mock('better-auth/next-js', () => ({
  toNextJsHandler: vi.fn(() => ({
    GET: mockBetterAuthGET,
    POST: mockBetterAuthPOST,
  })),
}));

// Mock @/lib/auth/config to prevent betterAuth({...}) module-scope side effects
// (Prisma adapter initialisation, email-client validation, etc.).
// Gotcha #13 from .claude/skills/testing/gotchas.md.
vi.mock('@/lib/auth/config', () => ({
  auth: {},
}));

// --- Deferred imports (after all vi.mock hoists are in place) ---

import { GET, POST } from '@/app/api/auth/[...all]/route';
import { getRouteLogger } from '@/lib/api/context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a NextRequest for the given method targeting an auth sub-path. */
function makeRequest(method: 'GET' | 'POST', subPath = 'session', body?: unknown): NextRequest {
  const url = `http://localhost:3000/api/auth/${subPath}`;
  return new NextRequest(url, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Create a minimal Response to return from the mocked better-auth handler. */
function makeAuthResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/auth/[...all]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRouteLogger).mockResolvedValue(mockLog as any);
  });

  it('dispatches to the better-auth GET handler and returns its response', async () => {
    // Arrange
    const authResponse = makeAuthResponse(200, { session: { id: 'sess-1' } });
    mockBetterAuthGET.mockResolvedValue(authResponse);
    const request = makeRequest('GET', 'session');

    // Act
    const response = await GET(request);

    // Assert — route mirrors the status from the better-auth handler
    expect(response.status).toBe(200);
    // Assert — the better-auth GET handler was called with the original request
    expect(mockBetterAuthGET).toHaveBeenCalledWith(request);
    // Assert — the POST handler was NOT called for a GET request
    expect(mockBetterAuthPOST).not.toHaveBeenCalled();
  });

  it('logs the auth sub-path on request start and completion', async () => {
    // Arrange
    const authResponse = makeAuthResponse(200, {});
    mockBetterAuthGET.mockResolvedValue(authResponse);
    const request = makeRequest('GET', 'session');

    // Act
    await GET(request);

    // Assert — request-start log includes the authPath
    expect(mockLog.info).toHaveBeenCalledWith(
      'Auth GET request',
      expect.objectContaining({ authPath: 'session' })
    );
    // Assert — completion log includes the authPath and mirrored status
    expect(mockLog.info).toHaveBeenCalledWith(
      'Auth GET completed',
      expect.objectContaining({ authPath: 'session', status: 200 })
    );
  });

  it('mirrors non-200 statuses from the better-auth GET handler', async () => {
    // Arrange — better-auth returns 401 for an expired session token
    const authResponse = makeAuthResponse(401, { error: 'Unauthorized' });
    mockBetterAuthGET.mockResolvedValue(authResponse);
    const request = makeRequest('GET', 'session');

    // Act
    const response = await GET(request);

    // Assert — route passes the status through unchanged
    expect(response.status).toBe(401);
    expect(mockBetterAuthGET).toHaveBeenCalledWith(request);
  });

  it('re-throws errors from the better-auth GET handler', async () => {
    // Arrange — better-auth handler throws (e.g. network/adapter failure)
    const handlerError = new Error('adapter failure');
    mockBetterAuthGET.mockRejectedValue(handlerError);
    const request = makeRequest('GET', 'session');

    // Act + Assert — error propagates through the route
    await expect(GET(request)).rejects.toThrow('adapter failure');

    // Assert — the error is logged before being re-thrown
    expect(mockLog.error).toHaveBeenCalledWith(
      'Auth GET failed',
      handlerError,
      expect.objectContaining({ authPath: 'session' })
    );
  });
});

describe('POST /api/auth/[...all]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRouteLogger).mockResolvedValue(mockLog as any);
  });

  it('dispatches to the better-auth POST handler and returns its response', async () => {
    // Arrange
    const authResponse = makeAuthResponse(200, { token: 'tok-abc' });
    mockBetterAuthPOST.mockResolvedValue(authResponse);
    const request = makeRequest('POST', 'sign-in/email', {
      email: 'user@example.com',
      password: 's3cret',
    });

    // Act
    const response = await POST(request);

    // Assert — route mirrors the status from the better-auth handler
    expect(response.status).toBe(200);
    // Assert — the better-auth POST handler was called with the original request
    // (body intact — route does not buffer or transform the body)
    expect(mockBetterAuthPOST).toHaveBeenCalledWith(request);
    // Assert — the GET handler was NOT called for a POST request
    expect(mockBetterAuthGET).not.toHaveBeenCalled();
  });

  it('logs the auth sub-path on request start and completion', async () => {
    // Arrange
    const authResponse = makeAuthResponse(201, { user: { id: 'u-1' } });
    mockBetterAuthPOST.mockResolvedValue(authResponse);
    const request = makeRequest('POST', 'sign-up');

    // Act
    await POST(request);

    // Assert — request-start log includes the authPath
    expect(mockLog.info).toHaveBeenCalledWith(
      'Auth POST request',
      expect.objectContaining({ authPath: 'sign-up' })
    );
    // Assert — completion log includes the authPath and mirrored status
    expect(mockLog.info).toHaveBeenCalledWith(
      'Auth POST completed',
      expect.objectContaining({ authPath: 'sign-up', status: 201 })
    );
  });

  it('mirrors non-200 statuses from the better-auth POST handler', async () => {
    // Arrange — better-auth returns 400 for invalid credentials
    const authResponse = makeAuthResponse(400, {
      error: { code: 'INVALID_CREDENTIALS', message: 'Wrong password' },
    });
    mockBetterAuthPOST.mockResolvedValue(authResponse);
    const request = makeRequest('POST', 'sign-in/email', {
      email: 'user@example.com',
      password: 'wrong',
    });

    // Act
    const response = await POST(request);

    // Assert — route passes the status through unchanged
    expect(response.status).toBe(400);
    expect(mockBetterAuthPOST).toHaveBeenCalledWith(request);
  });

  it('re-throws errors from the better-auth POST handler', async () => {
    // Arrange — better-auth handler throws (e.g. DB write failure)
    const handlerError = new Error('db write failed');
    mockBetterAuthPOST.mockRejectedValue(handlerError);
    const request = makeRequest('POST', 'sign-up', { email: 'a@b.com' });

    // Act + Assert — error propagates through the route
    await expect(POST(request)).rejects.toThrow('db write failed');

    // Assert — the error is logged before being re-thrown
    expect(mockLog.error).toHaveBeenCalledWith(
      'Auth POST failed',
      handlerError,
      expect.objectContaining({ authPath: 'sign-up' })
    );
  });
});
