/**
 * Unit Tests: reject/chat route — thin CORS wrapper
 *
 * Tests the route's responsibility: enforce single-origin CORS via
 * `singleOriginCorsHeaders`, reject disallowed origins with 403, and
 * delegate to `handleRejectRequest` with the correct `actorLabel` and
 * `corsHeaders` when the origin is allowed.
 *
 * The route imports `singleOriginCorsHeaders` and `handleRejectRequest`
 * from `@/lib/orchestration/approval-route-helpers`. Both are mocked
 * here so tests cover the route's thin wrapper logic only — the helper's
 * own behaviour is covered by approval-route-helpers unit tests.
 *
 * Test Coverage:
 * - OPTIONS: allowed origin → 204 + CORS headers from helper
 * - OPTIONS: mismatched origin → 403 (helper returns undefined)
 * - OPTIONS: null origin → 403 (rejected by helper returning undefined)
 * - POST: denied origin → 403 JSON ORIGIN_DENIED, handleRejectRequest NOT called
 * - POST: allowed origin → delegates with correct { actorLabel, corsHeaders }
 *
 * @see app/api/v1/orchestration/approvals/[id]/reject/chat/route.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSingleOriginCorsHeaders = vi.fn();
const mockHandleRejectRequest = vi.fn();

vi.mock('@/lib/orchestration/approval-route-helpers', () => ({
  singleOriginCorsHeaders: (...args: unknown[]): unknown => mockSingleOriginCorsHeaders(...args),
  handleRejectRequest: (...args: unknown[]): unknown => mockHandleRejectRequest(...args),
  // Export other named exports as pass-through to avoid import errors
  allowlistCorsHeaders: vi.fn(),
  handleApproveRequest: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
  },
}));

// Import the route handlers after mocks are set up
import { OPTIONS, POST } from '@/app/api/v1/orchestration/approvals/[id]/reject/chat/route';

// ── Constants ──────────────────────────────────────────────────────────────

const APP_URL = 'https://app.example.com';
const BASE_URL = `${APP_URL}/api/v1/orchestration/approvals/cuid-fake-1234567890abcd/reject/chat`;

/**
 * Build a minimal request stub that satisfies what the route reads:
 * `.headers.get('origin')` and the params promise.
 *
 * Note: `Origin` is a forbidden header in the Fetch spec — browsers and
 * jsdom silently drop it from `new Request(...)` calls. A partial stub
 * is the only reliable approach for origin-based tests.
 */
function makeRequest(origin?: string | null): NextRequest {
  const headers = new Map<string, string>([['content-type', 'application/json']]);
  if (origin === null) {
    headers.set('origin', 'null');
  } else if (origin !== undefined) {
    headers.set('origin', origin);
  }
  return {
    method: 'POST',
    nextUrl: new URL(BASE_URL),
    headers: {
      get: (name: string): string | null => headers.get(name.toLowerCase()) ?? null,
    },
  } as unknown as NextRequest;
}

/** Sentinel Response returned by the `handleRejectRequest` mock. */
function makeSentinelResponse(): Response {
  return new Response(JSON.stringify({ success: true, data: { status: 'rejected' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** CORS headers object returned by `singleOriginCorsHeaders` when origin is allowed. */
function makeAllowedCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': APP_URL,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('reject/chat route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── OPTIONS ──────────────────────────────────────────────────────────────

  describe('OPTIONS — preflight handling', () => {
    it('returns 204 with CORS headers when origin matches NEXT_PUBLIC_APP_URL', () => {
      // Arrange: helper returns CORS headers for the matched origin
      const corsHeaders = makeAllowedCorsHeaders();
      mockSingleOriginCorsHeaders.mockReturnValue(corsHeaders);
      const request = makeRequest(APP_URL);

      // Act
      const response = OPTIONS(request);

      // Assert: route wraps the returned headers into a 204
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_URL);
      expect(response.headers.get('Vary')).toBe('Origin');
      // Confirm the route forwarded origin + allowedOrigin to the helper
      expect(mockSingleOriginCorsHeaders).toHaveBeenCalledWith(APP_URL, APP_URL, 'POST');
    });

    it('returns 403 when origin does not match (helper returns undefined)', () => {
      // Arrange: helper returns undefined for a mismatched origin
      mockSingleOriginCorsHeaders.mockReturnValue(undefined);
      const request = makeRequest('https://attacker.com');

      // Act
      const response = OPTIONS(request);

      // Assert: route short-circuits with 403, no body
      expect(response.status).toBe(403);
      // Confirm the helper was consulted with the foreign origin
      expect(mockSingleOriginCorsHeaders).toHaveBeenCalledWith(
        'https://attacker.com',
        APP_URL,
        'POST'
      );
    });

    it('returns 403 when origin header is null (null origin explicitly rejected)', () => {
      // Arrange: null origin — helper returns undefined (rejects per docstring)
      mockSingleOriginCorsHeaders.mockReturnValue(undefined);
      const request = makeRequest(null);

      // Act
      const response = OPTIONS(request);

      // Assert: 403 regardless of allowlist
      expect(response.status).toBe(403);
      // Route passes the string 'null' (Origin: null header value) to the helper
      expect(mockSingleOriginCorsHeaders).toHaveBeenCalledWith('null', APP_URL, 'POST');
    });
  });

  // ── POST ─────────────────────────────────────────────────────────────────

  describe('POST — delegation and CORS enforcement', () => {
    it('returns 403 JSON with ORIGIN_DENIED when CORS check fails, and does NOT call handleRejectRequest', async () => {
      // Arrange: helper returns undefined (denied origin)
      mockSingleOriginCorsHeaders.mockReturnValue(undefined);
      const request = makeRequest('https://attacker.com');
      const params = Promise.resolve({ id: 'cuid-fake-1234567890abcd' });

      // Act
      const response = await POST(request, { params });
      const body = (await response.json()) as {
        success: boolean;
        error: { code: string; message: string };
      };

      // Assert: correct status + envelope shape
      expect(response.status).toBe(403);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('ORIGIN_DENIED');
      expect(typeof body.error.message).toBe('string');

      // Critical regression-catcher: delegate must NOT have been called
      expect(mockHandleRejectRequest).not.toHaveBeenCalled();
    });

    it('delegates to handleRejectRequest with actorLabel "token:chat" and correct corsHeaders when origin is allowed', async () => {
      // Arrange: helper returns CORS headers; delegate returns sentinel response
      const corsHeaders = makeAllowedCorsHeaders();
      mockSingleOriginCorsHeaders.mockReturnValue(corsHeaders);
      const sentinel = makeSentinelResponse();
      mockHandleRejectRequest.mockResolvedValue(sentinel);

      const request = makeRequest(APP_URL);
      const params = Promise.resolve({ id: 'cuid-fake-1234567890abcd' });

      // Act
      const response = await POST(request, { params });

      // Assert: route returns exactly what the delegate returned
      expect(response).toBe(sentinel);

      // Assert: delegate called with exact options shape — actorLabel pinned to 'token:chat'
      expect(mockHandleRejectRequest).toHaveBeenCalledTimes(1);
      expect(mockHandleRejectRequest).toHaveBeenCalledWith(request, params, {
        actorLabel: 'token:chat',
        corsHeaders,
      });
    });
  });
});
