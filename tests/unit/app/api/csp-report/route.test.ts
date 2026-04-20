/**
 * Unit tests for app/api/csp-report/route.ts
 *
 * Contract under test:
 * - POST always returns 204 (success, invalid body, errors)
 * - POST rate-limits via cspReportLimiter and short-circuits before body parse
 * - POST logs CSP violations via log.warn with structured payload
 * - POST silently accepts malformed bodies and logs failures via log.error
 * - OPTIONS returns 204 with CORS preflight headers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { RateLimitResult } from '@/lib/security/rate-limit';
import { createMockLogger } from '@/tests/types/mocks';

// --- Module mocks (hoisted) -----------------------------------------------

// Mock getRouteLogger — returns a Logger-compatible mock from the shared factory
const mockLog = createMockLogger();

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(),
}));

// Mock rate-limit module
vi.mock('@/lib/security/rate-limit', () => ({
  cspReportLimiter: {
    check: vi.fn(),
  },
  createRateLimitResponse: vi.fn(),
}));

// Mock client IP utility
vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(),
}));

// --- Deferred imports (after mocks are hoisted) ----------------------------

import { POST, OPTIONS } from '@/app/api/csp-report/route';
import { getRouteLogger } from '@/lib/api/context';
import { cspReportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

// ---------------------------------------------------------------------------

/** Helper to construct a valid CSP violation request */
function makePostRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://test.local/api/csp-report', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

/** A minimal valid CSP report payload */
const validReport = {
  'csp-report': {
    'document-uri': 'https://example.com/page',
    'violated-directive': 'script-src',
    'effective-directive': 'script-src',
    'blocked-uri': 'https://evil.com/script.js',
    'source-file': 'https://example.com/page',
    'line-number': 42,
    'column-number': 7,
  },
};

// ---------------------------------------------------------------------------

describe('POST /api/csp-report', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-stub getRouteLogger to return the shared mock log object
    vi.mocked(getRouteLogger).mockResolvedValue(mockLog);

    // Default: rate limiter allows the request
    vi.mocked(cspReportLimiter.check).mockReturnValue({
      success: true,
      limit: 20,
      remaining: 19,
      reset: Math.ceil((Date.now() + 60_000) / 1000),
    } satisfies RateLimitResult);

    // Default IP sentinel
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns 204 with an empty body when a valid csp-report payload is accepted', async () => {
    // Arrange
    const request = makePostRequest(validReport, { 'user-agent': 'test-UA' });

    // Act
    const response = await POST(request);

    // Assert — status first (contract), then body, then side-effects
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mockLog.warn).toHaveBeenCalledWith(
      'CSP Violation',
      expect.objectContaining({
        type: 'csp-violation',
        documentUri: 'https://example.com/page',
        violatedDirective: 'script-src',
        effectiveDirective: 'script-src',
        blockedUri: 'https://evil.com/script.js',
        sourceFile: 'https://example.com/page',
        lineNumber: 42,
        columnNumber: 7,
      })
    );
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  it('returns the rate-limit sentinel response when cspReportLimiter.check() reports failure', async () => {
    // Arrange
    const sentinelResponse = new Response(null, { status: 429 });
    vi.mocked(cspReportLimiter.check).mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: Math.ceil((Date.now() + 60_000) / 1000),
    } satisfies RateLimitResult);
    vi.mocked(createRateLimitResponse).mockReturnValue(sentinelResponse);

    const request = makePostRequest(validReport);

    // Act
    const response = await POST(request);

    // Assert — status, identity (same object proves short-circuit), and no side-effects
    expect(response.status).toBe(429);
    expect(response).toBe(sentinelResponse);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Schema rejection
  // -------------------------------------------------------------------------

  it('returns 204 and does not log at warn OR error level when the Zod schema rejects the payload (silent accept)', async () => {
    // Arrange — 'document-uri' must be a string; passing a number fails schema
    const request = makePostRequest({
      'csp-report': { 'document-uri': 12345 },
    });

    // Act
    const response = await POST(request);

    // Assert — 204, no body, no log calls (silent accept)
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Valid body without violation data
  // -------------------------------------------------------------------------

  it('returns 204 and does not log when the body has no csp-report key', async () => {
    // Arrange — csp-report is optional in the schema; empty object is valid but has no violation
    const request = makePostRequest({});

    // Act
    const response = await POST(request);

    // Assert — 204, no log (no violation data to log)
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Header / IP wiring
  // -------------------------------------------------------------------------

  it('passes the result of getClientIP(request) into cspReportLimiter.check()', async () => {
    // Arrange — sentinel IP different from the beforeEach default
    vi.mocked(getClientIP).mockReturnValue('10.0.0.42');
    const request = makePostRequest(validReport);

    // Act
    await POST(request);

    // Assert — rate limiter received the IP sentinel, proving the wiring
    expect(cspReportLimiter.check).toHaveBeenCalledWith('10.0.0.42');
  });

  it('reads the user-agent header and forwards it into the log payload', async () => {
    // Arrange
    const request = makePostRequest(validReport, { 'user-agent': 'test-UA' });

    // Act
    await POST(request);

    // Assert — log.warn second arg includes the forwarded user-agent value
    expect(mockLog.warn).toHaveBeenCalledWith(
      'CSP Violation',
      expect.objectContaining({ userAgent: 'test-UA' })
    );
  });

  // -------------------------------------------------------------------------
  // Error-catch path
  // -------------------------------------------------------------------------

  it('returns 204 and calls log.error when request.json() throws a SyntaxError', async () => {
    // Arrange — non-JSON body forces request.json() to throw
    const request = new NextRequest('http://test.local/api/csp-report', {
      method: 'POST',
      body: '{not-json',
      headers: { 'content-type': 'application/json' },
    });

    // Act
    const response = await POST(request);

    // Assert — status first, then body, then side-effects
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mockLog.error).toHaveBeenCalledWith('CSP report processing failed', expect.any(Error));
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('returns 204 and calls log.error when the rate-limit check itself throws', async () => {
    // Arrange — rate limiter throws before body parse
    vi.mocked(cspReportLimiter.check).mockImplementation(() => {
      throw new Error('rate-limiter internal failure');
    });
    const request = makePostRequest(validReport);

    // Act
    const response = await POST(request);

    // Assert — outer try-catch covers failures before JSON parse too
    expect(response.status).toBe(204);
    expect(mockLog.error).toHaveBeenCalledWith('CSP report processing failed', expect.any(Error));
  });
});

// ---------------------------------------------------------------------------

describe('OPTIONS /api/csp-report', () => {
  it('returns 204 with the three expected CORS headers for OPTIONS preflight', () => {
    // Act
    const response = OPTIONS();

    // Assert — status first, then each header individually
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
