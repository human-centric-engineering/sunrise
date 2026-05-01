/**
 * Unit Tests: API Route Context Utilities
 *
 * Tests the `getRouteLogger` helper that builds a scoped logger from the
 * incoming request and the current session.
 *
 * Surface under test:
 * - `getRouteLogger(request)` — calls `getFullContext` + `getEndpointPath`,
 *   then returns `logger.withContext({...context, endpoint})`.
 *
 * Test Coverage:
 * - Builds a scoped logger that includes requestId, method, url, endpoint,
 *   userId, sessionId, and email sourced from request + session context.
 * - Returns a scoped logger when session fields are absent (unauthenticated).
 * - Endpoint path is stripped of query-string (only pathname is forwarded).
 * - The returned logger is whatever `logger.withContext` produces (contract
 *   test: correct arguments, correct return value forwarded).
 *
 * NOTE: `tests/setup.ts` globally mocks `@/lib/api/context` so that other
 * tests do not need to wire up the real implementation. This test unmocks it
 * and mocks the dependencies (`@/lib/logging/context`, `@/lib/logging`) to
 * exercise the actual module code.
 *
 * @see lib/api/context.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger } from '@/tests/types/mocks';

/**
 * Unmock the module under test so the real implementation is used.
 * (tests/setup.ts globally mocks @/lib/api/context.)
 */
vi.unmock('@/lib/api/context');

/**
 * Mock the two direct dependencies of lib/api/context.ts so that we can
 * drive all scenarios without touching next/headers or better-auth.
 */
vi.mock('@/lib/logging/context', () => ({
  getFullContext: vi.fn(),
  getEndpointPath: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    withContext: vi.fn(),
  },
}));

import { getRouteLogger } from '@/lib/api/context';
import { getFullContext, getEndpointPath } from '@/lib/logging/context';
import { logger } from '@/lib/logging';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createRequest(url = 'http://localhost:3000/api/v1/users?page=1'): Request {
  return new Request(url, { method: 'GET' });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('getRouteLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call getFullContext with the request and getEndpointPath with the request', async () => {
    // Arrange
    const request = createRequest();
    const mockLog = createMockLogger();
    vi.mocked(getFullContext).mockResolvedValue({
      requestId: 'req-abc',
      method: 'GET',
      url: 'http://localhost:3000/api/v1/users?page=1',
      userAgent: 'test-agent',
      userId: 'user-1',
      sessionId: 'session-1',
      email: 'user@example.com',
    });
    vi.mocked(getEndpointPath).mockReturnValue('/api/v1/users');
    vi.mocked(logger.withContext).mockReturnValue(mockLog as any);

    // Act
    await getRouteLogger(request);

    // Assert — the request object is threaded through to both dependencies
    expect(vi.mocked(getFullContext)).toHaveBeenCalledWith(request);
    expect(vi.mocked(getEndpointPath)).toHaveBeenCalledWith(request);
  });

  it('should merge full context with the endpoint path and pass combined object to logger.withContext', async () => {
    // Arrange
    const request = createRequest('http://localhost:3000/api/v1/orders?status=open');
    const mockLog = createMockLogger();
    vi.mocked(getFullContext).mockResolvedValue({
      requestId: 'req-xyz',
      method: 'POST',
      url: 'http://localhost:3000/api/v1/orders?status=open',
      userAgent: 'Mozilla/5.0',
      userId: 'user-42',
      sessionId: 'session-99',
      email: 'customer@example.com',
    });
    vi.mocked(getEndpointPath).mockReturnValue('/api/v1/orders');
    vi.mocked(logger.withContext).mockReturnValue(mockLog as any);

    // Act
    await getRouteLogger(request);

    // Assert — logger receives the merged context including the endpoint path
    expect(vi.mocked(logger.withContext)).toHaveBeenCalledWith({
      requestId: 'req-xyz',
      method: 'POST',
      url: 'http://localhost:3000/api/v1/orders?status=open',
      userAgent: 'Mozilla/5.0',
      userId: 'user-42',
      sessionId: 'session-99',
      email: 'customer@example.com',
      endpoint: '/api/v1/orders',
    });
  });

  it('should return the logger instance produced by logger.withContext', async () => {
    // Arrange
    const request = createRequest();
    const expectedLogger = createMockLogger();
    vi.mocked(getFullContext).mockResolvedValue({
      requestId: 'req-1',
    });
    vi.mocked(getEndpointPath).mockReturnValue('/api/v1/test');
    vi.mocked(logger.withContext).mockReturnValue(expectedLogger as any);

    // Act
    const result = await getRouteLogger(request);

    // Assert — the caller receives exactly what withContext returned
    expect(result).toBe(expectedLogger);
  });

  it('should handle unauthenticated requests — no userId, sessionId, or email in context', async () => {
    // Arrange: getFullContext returns only the request-level fields (no user context)
    const request = createRequest('http://localhost:3000/api/v1/public');
    const mockLog = createMockLogger();
    vi.mocked(getFullContext).mockResolvedValue({
      requestId: 'req-anon',
      method: 'GET',
      url: 'http://localhost:3000/api/v1/public',
      userAgent: undefined,
      // userId, sessionId, email absent — unauthenticated path
    });
    vi.mocked(getEndpointPath).mockReturnValue('/api/v1/public');
    vi.mocked(logger.withContext).mockReturnValue(mockLog as any);

    // Act
    await getRouteLogger(request);

    // Assert — withContext is still called; absent fields are not injected
    const callArg = vi.mocked(logger.withContext).mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg).toMatchObject({
      requestId: 'req-anon',
      method: 'GET',
      endpoint: '/api/v1/public',
    });
    expect(callArg).not.toHaveProperty('userId');
    expect(callArg).not.toHaveProperty('sessionId');
    expect(callArg).not.toHaveProperty('email');
  });

  it('should include endpoint as the stripped pathname returned by getEndpointPath, not the raw URL', async () => {
    // Arrange — getEndpointPath is responsible for stripping the query string;
    // this test verifies the value it returns is forwarded verbatim to withContext.
    const request = createRequest('http://localhost:3000/api/v1/search?q=hello&page=2');
    const mockLog = createMockLogger();
    vi.mocked(getFullContext).mockResolvedValue({ requestId: 'req-search' });
    // Simulate getEndpointPath stripping the query string
    vi.mocked(getEndpointPath).mockReturnValue('/api/v1/search');
    vi.mocked(logger.withContext).mockReturnValue(mockLog as any);

    // Act
    await getRouteLogger(request);

    // Assert — the endpoint value passed to withContext is the pathname only
    const callArg = vi.mocked(logger.withContext).mock.calls[0]?.[0];
    expect(callArg).toHaveProperty('endpoint', '/api/v1/search');
  });
});
