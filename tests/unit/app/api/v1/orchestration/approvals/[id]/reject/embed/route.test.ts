/**
 * Unit Tests: reject/embed route — thin allowlist-CORS wrapper
 *
 * Tests the route's responsibility: resolve CORS via
 * `allowlistCorsHeaders` using `embedAllowedOrigins` from settings,
 * reject disallowed origins with 403, and delegate to
 * `handleRejectRequest` with `actorLabel: 'token:embed'` when allowed.
 *
 * Both `allowlistCorsHeaders` and `handleRejectRequest` are mocked so
 * tests cover only the route's thin wrapper logic. `getOrchestrationSettings`
 * is also mocked to control the allowlist without touching the DB.
 *
 * Test Coverage:
 * - OPTIONS: matching origin → 204 + CORS headers
 * - OPTIONS: non-matching origin → 403
 * - OPTIONS: null origin with non-wildcard allowlist → 403
 * - OPTIONS: empty embedAllowedOrigins → 403
 * - POST: denied origin → 403 JSON ORIGIN_DENIED, handleRejectRequest NOT called
 * - POST: allowed origin → delegates with { actorLabel: 'token:embed', corsHeaders }
 * - POST: getOrchestrationSettings throws → error propagates (no try/catch in route)
 *
 * Wildcard semantics: when '*' is in `embedAllowedOrigins`, `allowlistCorsHeaders`
 * returns literal `Access-Control-Allow-Origin: *` for any origin (including null).
 * The wildcard-passthrough case is covered at L187 below.
 * Helper-level tests: tests/unit/lib/orchestration/approval-route-helpers.test.ts.
 *
 * @see app/api/v1/orchestration/approvals/[id]/reject/embed/route.ts
 * @see lib/orchestration/approval-route-helpers.ts (allowlistCorsHeaders)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockAllowlistCorsHeaders = vi.fn();
const mockHandleRejectRequest = vi.fn();
const mockGetOrchestrationSettings = vi.fn();

vi.mock('@/lib/orchestration/approval-route-helpers', () => ({
  allowlistCorsHeaders: (...args: unknown[]): unknown => mockAllowlistCorsHeaders(...args),
  handleRejectRequest: (...args: unknown[]): unknown => mockHandleRejectRequest(...args),
  // Export other named exports to avoid import errors
  singleOriginCorsHeaders: vi.fn(),
  handleApproveRequest: vi.fn(),
}));

vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: (): unknown => mockGetOrchestrationSettings(),
}));

// Import the route handlers after mocks are set up
import { OPTIONS, POST } from '@/app/api/v1/orchestration/approvals/[id]/reject/embed/route';

// ── Constants ──────────────────────────────────────────────────────────────

const PARTNER_ORIGIN = 'https://partner.example.com';
const BASE_URL = `https://app.example.com/api/v1/orchestration/approvals/cuid-fake-1234567890abcd/reject/embed`;

/**
 * Build a minimal request stub. `Origin` is a forbidden Fetch header —
 * browsers and jsdom drop it silently, so a partial stub is required.
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

/** CORS headers object returned by `allowlistCorsHeaders` when origin is allowed. */
function makeAllowedCorsHeaders(origin: string = PARTNER_ORIGIN): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('reject/embed route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default settings: partner origin is allowlisted
    mockGetOrchestrationSettings.mockResolvedValue({
      embedAllowedOrigins: [PARTNER_ORIGIN],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── OPTIONS ──────────────────────────────────────────────────────────────

  describe('OPTIONS — preflight handling', () => {
    it('returns 204 with CORS headers when origin matches embedAllowedOrigins', async () => {
      // Arrange: helper returns CORS headers for the matched origin
      const corsHeaders = makeAllowedCorsHeaders();
      mockAllowlistCorsHeaders.mockReturnValue(corsHeaders);
      const request = makeRequest(PARTNER_ORIGIN);

      // Act
      const response = await OPTIONS(request);

      // Assert: 204 with the CORS headers the helper returned
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PARTNER_ORIGIN);
      expect(response.headers.get('Vary')).toBe('Origin');
      // Confirm helper was called with the resolved allowlist
      expect(mockAllowlistCorsHeaders).toHaveBeenCalledWith(
        PARTNER_ORIGIN,
        [PARTNER_ORIGIN],
        'POST'
      );
    });

    it('returns 403 when origin is not in embedAllowedOrigins (helper returns undefined)', async () => {
      // Arrange: helper returns undefined for a non-allowlisted origin
      mockAllowlistCorsHeaders.mockReturnValue(undefined);
      const request = makeRequest('https://nopartner.com');

      // Act
      const response = await OPTIONS(request);

      // Assert
      expect(response.status).toBe(403);
      expect(mockAllowlistCorsHeaders).toHaveBeenCalledWith(
        'https://nopartner.com',
        [PARTNER_ORIGIN],
        'POST'
      );
    });

    it('returns 403 when origin is null and the helper denies (no wildcard configured)', async () => {
      // Arrange: helper returns undefined (denial). For an exact-match allowlist
      // without `'*'`, the helper rejects null origins. The wildcard-allowed
      // case is covered separately below.
      mockAllowlistCorsHeaders.mockReturnValue(undefined);
      const request = makeRequest(null);

      // Act
      const response = await OPTIONS(request);

      // Assert: 403 when helper denies
      expect(response.status).toBe(403);
      // Route passes the string 'null' (the Origin: null header value) to the helper
      expect(mockAllowlistCorsHeaders).toHaveBeenCalledWith('null', [PARTNER_ORIGIN], 'POST');
    });

    it('returns 403 when embedAllowedOrigins is empty (no origins allowlisted)', async () => {
      // Arrange: empty allowlist — helper returns undefined
      mockGetOrchestrationSettings.mockResolvedValue({ embedAllowedOrigins: [] });
      mockAllowlistCorsHeaders.mockReturnValue(undefined);
      const request = makeRequest('https://anywhere.com');

      // Act
      const response = await OPTIONS(request);

      // Assert: 403 for all origins when allowlist is empty
      expect(response.status).toBe(403);
      expect(mockAllowlistCorsHeaders).toHaveBeenCalledWith('https://anywhere.com', [], 'POST');
    });

    it("returns 204 when origin is null and the allowlist includes '*' (wildcard passthrough)", async () => {
      // Arrange: when '*' is in the allowlist, the helper returns literal
      // wildcard CORS headers regardless of the requesting origin (including
      // null/missing). The route's job is to pass them through.
      // Helper-level wildcard semantics covered in
      // tests/unit/lib/orchestration/approval-route-helpers.test.ts.
      const wildcardHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      };
      mockGetOrchestrationSettings.mockResolvedValue({ embedAllowedOrigins: ['*'] });
      mockAllowlistCorsHeaders.mockReturnValue(wildcardHeaders);
      const request = makeRequest(null);

      // Act
      const response = await OPTIONS(request);

      // Assert: 204 + wildcard headers attached
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(mockAllowlistCorsHeaders).toHaveBeenCalledWith('null', ['*'], 'POST');
    });
  });

  // ── POST ─────────────────────────────────────────────────────────────────

  describe('POST — delegation and CORS enforcement', () => {
    it('returns 403 JSON with ORIGIN_DENIED when CORS check fails, and does NOT call handleRejectRequest', async () => {
      // Arrange: helper returns undefined (denied origin)
      mockAllowlistCorsHeaders.mockReturnValue(undefined);
      const request = makeRequest('https://attacker.com');
      const params = Promise.resolve({ id: 'cuid-fake-1234567890abcd' });

      // Act
      const response = await POST(request, { params });
      const body = (await response.json()) as {
        success: boolean;
        error: { code: string; message: string };
      };

      // Assert: correct status + full envelope shape
      expect(response.status).toBe(403);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('ORIGIN_DENIED');
      expect(typeof body.error.message).toBe('string');

      // Critical regression-catcher: delegate must NOT have been called
      expect(mockHandleRejectRequest).not.toHaveBeenCalled();
    });

    it('delegates to handleRejectRequest with actorLabel "token:embed" and correct corsHeaders when origin is allowlisted', async () => {
      // Arrange: helper allows the origin; delegate returns sentinel
      const corsHeaders = makeAllowedCorsHeaders();
      mockAllowlistCorsHeaders.mockReturnValue(corsHeaders);
      const sentinel = makeSentinelResponse();
      mockHandleRejectRequest.mockResolvedValue(sentinel);

      const request = makeRequest(PARTNER_ORIGIN);
      const params = Promise.resolve({ id: 'cuid-fake-1234567890abcd' });

      // Act
      const response = await POST(request, { params });

      // Assert: route returns whatever the delegate returned (passthrough)
      expect(response).toBe(sentinel);

      // Assert: delegate called with exact options shape — actorLabel pinned to 'token:embed'
      expect(mockHandleRejectRequest).toHaveBeenCalledTimes(1);
      expect(mockHandleRejectRequest).toHaveBeenCalledWith(request, params, {
        actorLabel: 'token:embed',
        corsHeaders,
      });
    });

    it('propagates error from getOrchestrationSettings (no try/catch in route)', async () => {
      // Arrange: settings fetch throws — route has no try/catch so it propagates
      const settingsError = new Error('DB connection failed');
      mockGetOrchestrationSettings.mockRejectedValue(settingsError);
      const request = makeRequest(PARTNER_ORIGIN);
      const params = Promise.resolve({ id: 'cuid-fake-1234567890abcd' });

      // Act + Assert: the promise rejects with the original error
      await expect(POST(request, { params })).rejects.toThrow('DB connection failed');

      // Confirm delegate was never reached
      expect(mockHandleRejectRequest).not.toHaveBeenCalled();
    });
  });
});
