/**
 * Unit Test: Proxy (Next.js project-root proxy.ts)
 *
 * Tests the proxy function that runs before every matched request:
 * - Origin validation (CSRF protection for state-changing methods)
 * - Rate limiting (delegated to applyRateLimit; this file mocks the dispatcher
 *   and asserts the integration — the dispatcher itself has its own tests at
 *   tests/unit/lib/security/rate-limit-middleware.test.ts)
 * - Authentication via better-auth session cookies
 * - Protected route redirects + auth route redirects
 * - Request ID generation + propagation
 * - CSP nonce generation + forwarding via x-nonce header
 * - Security headers
 *
 * Rate-limit enforcement moved into the policy table + dispatcher pattern
 * in commit c0a1b5cb. This test file mocks `applyRateLimit` so the proxy
 * wiring is exercised in isolation — drive its return value per test.
 *
 * @see proxy.ts
 * @see lib/security/rate-limit-middleware.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { proxy } from '@/proxy';

vi.mock('@/lib/logging/context', () => ({
  generateRequestId: vi.fn(() => 'test-request-id-123'),
}));

vi.mock('@/lib/security/headers', () => ({
  setSecurityHeaders: vi.fn(),
}));

// Rate-limit dispatcher — the unit under integration here. The dispatcher's
// own behaviour (policy lookup, key resolution, limiter check, 429 shape) is
// covered in rate-limit-middleware.test.ts; here we drive its return value
// per test to verify the proxy's wiring (request-ID propagation on 429,
// pass-through on null).
vi.mock('@/lib/security/rate-limit-middleware', () => ({
  applyRateLimit: vi.fn(async () => null),
}));

import { applyRateLimit } from '@/lib/security/rate-limit-middleware';
import { logger } from '@/lib/logging';
import { signVisitorId, verifyVisitorId, VISITOR_COOKIE_NAME } from '@/lib/logging/visitor-id';

function createMockRequest(
  pathname: string,
  options: {
    cookies?: Record<string, string>;
    method?: string;
    headers?: Record<string, string>;
  } = {}
): NextRequest {
  const url = `http://localhost:3000${pathname}`;
  const { cookies = {}, method = 'GET', headers = {} } = options;

  const request = {
    nextUrl: new URL(url),
    url,
    method,
    headers: new Map(Object.entries(headers)),
    cookies: {
      get: (name: string) => {
        return cookies[name] ? { name, value: cookies[name] } : undefined;
      },
    },
  } as unknown as NextRequest;

  return request;
}

describe('proxy (project root)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default — dispatcher allows the request through. Specific tests
    // override this to drive the 429 branch.
    vi.mocked(applyRateLimit).mockResolvedValue(null);
  });

  describe('isAuthenticated — HTTP cookie (better-auth.session_token)', () => {
    it('proceeds to the protected route when the HTTP cookie is present', async () => {
      const request = createMockRequest('/dashboard', {
        cookies: { 'better-auth.session_token': 'valid-session-token' },
      });

      const response = await proxy(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });
  });

  describe('isAuthenticated — HTTPS cookie (__Secure-better-auth.session_token)', () => {
    it('proceeds to the protected route when the HTTPS cookie is present', async () => {
      const request = createMockRequest('/dashboard', {
        cookies: { '__Secure-better-auth.session_token': 'valid-secure-session-token' },
      });

      const response = await proxy(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('allows access to /settings with the HTTPS cookie', async () => {
      const request = createMockRequest('/settings', {
        cookies: { '__Secure-better-auth.session_token': 'valid-secure-session-token' },
      });

      const response = await proxy(request);

      expect(response.status).toBe(200);
    });

    it('allows access to /profile with the HTTPS cookie', async () => {
      const request = createMockRequest('/profile', {
        cookies: { '__Secure-better-auth.session_token': 'valid-secure-session-token' },
      });

      const response = await proxy(request);

      expect(response.status).toBe(200);
    });
  });

  describe('isAuthenticated — both cookie variants present', () => {
    it('authenticates when both HTTP and HTTPS cookies are present', async () => {
      const request = createMockRequest('/dashboard', {
        cookies: {
          'better-auth.session_token': 'http-token',
          '__Secure-better-auth.session_token': 'https-token',
        },
      });

      const response = await proxy(request);

      expect(response.status).toBe(200);
    });
  });

  describe('Protected routes — unauthenticated', () => {
    it('redirects to /login when accessing /dashboard without a session', async () => {
      const request = createMockRequest('/dashboard', { cookies: {} });

      const response = await proxy(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('callbackUrl=%2Fdashboard');
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('redirects to /login when accessing /settings without a session', async () => {
      const request = createMockRequest('/settings', { cookies: {} });

      const response = await proxy(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('callbackUrl=%2Fsettings');
    });

    it('redirects to /login when accessing /profile without a session', async () => {
      const request = createMockRequest('/profile', { cookies: {} });

      const response = await proxy(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
    });
  });

  describe('Auth routes — authenticated users', () => {
    it('redirects to /dashboard when accessing /login with the HTTP cookie', async () => {
      const request = createMockRequest('/login', {
        cookies: { 'better-auth.session_token': 'valid-token' },
      });

      const response = await proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/dashboard');
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('redirects to /dashboard when accessing /signup with the HTTPS cookie', async () => {
      const request = createMockRequest('/signup', {
        cookies: { '__Secure-better-auth.session_token': 'valid-secure-token' },
      });

      const response = await proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/dashboard');
    });

    it('redirects to /dashboard when accessing /reset-password with a session', async () => {
      const request = createMockRequest('/reset-password', {
        cookies: { '__Secure-better-auth.session_token': 'valid-token' },
      });

      const response = await proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/dashboard');
    });
  });

  describe('Public routes', () => {
    it('allows unauthenticated access to the homepage', async () => {
      const request = createMockRequest('/', { cookies: {} });

      const response = await proxy(request);

      expect(response.status).toBe(200);
    });

    it('allows unauthenticated access to /about', async () => {
      const request = createMockRequest('/about', { cookies: {} });

      const response = await proxy(request);

      expect(response.status).toBe(200);
    });
  });

  describe('Request ID propagation', () => {
    it('adds the request ID to response headers', async () => {
      const request = createMockRequest('/', { cookies: {} });

      const response = await proxy(request);

      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('reuses an existing request ID from the inbound header instead of generating a new one', async () => {
      const { generateRequestId } = await import('@/lib/logging/context');

      const request = createMockRequest('/', {
        cookies: {},
        headers: { 'x-request-id': 'existing-request-id' },
      });

      const response = await proxy(request);

      expect(response.headers.get('x-request-id')).toBe('existing-request-id');
      expect(generateRequestId).not.toHaveBeenCalled();
    });
  });

  describe('Origin validation', () => {
    it('rejects POST requests whose Origin does not match Host', async () => {
      const request = createMockRequest('/api/v1/users', {
        method: 'POST',
        headers: {
          origin: 'https://evil.com',
          host: 'localhost:3000',
        },
      });

      const response = await proxy(request);

      expect(response.status).toBe(403);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
      const body = (await response.json()) as {
        success: boolean;
        error: { code: string; message: string };
      };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Invalid request origin');
    });

    it('allows POST requests when Origin matches Host', async () => {
      const request = createMockRequest('/api/v1/users', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          host: 'localhost:3000',
        },
      });

      const response = await proxy(request);

      expect(response.status).toBe(200);
    });

    it('allows GET requests through without an origin check', async () => {
      const request = createMockRequest('/api/v1/users', {
        method: 'GET',
        headers: {
          origin: 'https://evil.com',
          host: 'localhost:3000',
        },
      });

      const response = await proxy(request);

      expect(response.status).toBe(200);
    });

    it('rejects POST requests whose Origin header is malformed (URL parse throws)', async () => {
      // Arrange: validateOrigin's try/catch wraps `new URL(origin)`. A
      // malformed value triggers the catch branch and the function returns
      // false → proxy responds 403. Exercises an attacker-supplied bogus
      // header rather than a legitimately mismatched one.
      const request = createMockRequest('/api/v1/users', {
        method: 'POST',
        headers: {
          origin: 'not a valid url at all',
          host: 'localhost:3000',
        },
      });

      const response = await proxy(request);

      expect(response.status).toBe(403);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
      const body = (await response.json()) as {
        success: boolean;
        error: { code: string; message: string };
      };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Invalid request origin');
    });

    it.each(['PUT', 'DELETE', 'PATCH'] as const)(
      'rejects %s requests whose Origin does not match Host',
      async (method) => {
        const request = createMockRequest('/api/v1/users', {
          method,
          headers: {
            origin: 'https://evil.com',
            host: 'localhost:3000',
          },
        });

        const response = await proxy(request);

        expect(response.status).toBe(403);
        expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
        const body = (await response.json()) as {
          success: boolean;
          error: { code: string; message: string };
        };
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('FORBIDDEN');
        expect(body.error.message).toBe('Invalid request origin');
      }
    );
  });

  describe('Rate limiting — delegation to applyRateLimit', () => {
    it('calls applyRateLimit for every request that passes origin validation', async () => {
      const request = createMockRequest('/api/v1/users');

      await proxy(request);

      expect(applyRateLimit).toHaveBeenCalledTimes(1);
      expect(applyRateLimit).toHaveBeenCalledWith(request);
    });

    it('does not call applyRateLimit when origin validation rejects the request', async () => {
      const request = createMockRequest('/api/v1/users', {
        method: 'POST',
        headers: { origin: 'https://evil.com', host: 'localhost:3000' },
      });

      const response = await proxy(request);

      expect(response.status).toBe(403);
      // Origin check short-circuits before the rate-limit dispatcher.
      expect(applyRateLimit).not.toHaveBeenCalled();
    });

    it('returns the dispatcher 429 with the request ID propagated', async () => {
      const fake429 = new Response(
        JSON.stringify({
          success: false,
          error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60',
            'X-RateLimit-Limit': '30',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': '1234567890',
          },
        }
      );
      vi.mocked(applyRateLimit).mockResolvedValueOnce(fake429);

      const request = createMockRequest('/api/v1/admin/users', { method: 'GET' });

      const response = await proxy(request);

      expect(response.status).toBe(429);
      // Re-wrap preserves all dispatcher headers AND attaches the request ID.
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(response.headers.get('X-RateLimit-Reset')).toBe('1234567890');
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');

      // Body shape is preserved through the re-wrap.
      const body = (await response.json()) as {
        success: boolean;
        error: { code: string; message: string };
      };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('continues through to auth + headers when applyRateLimit returns null', async () => {
      vi.mocked(applyRateLimit).mockResolvedValueOnce(null);

      const request = createMockRequest('/api/v1/admin/users');

      const response = await proxy(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });
  });

  describe('Custom auth routes (request-ID + security headers propagation)', () => {
    it('sets security headers on /api/auth/send-verification-email', async () => {
      const { setSecurityHeaders } = await import('@/lib/security/headers');

      const request = createMockRequest('/api/auth/send-verification-email', {
        method: 'POST',
      });

      const response = await proxy(request);

      expect(setSecurityHeaders).toHaveBeenCalledWith(response, expect.any(String));
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('sets security headers on /api/auth/accept-invite', async () => {
      const { setSecurityHeaders } = await import('@/lib/security/headers');

      const request = createMockRequest('/api/auth/accept-invite', { method: 'POST' });

      const response = await proxy(request);

      expect(setSecurityHeaders).toHaveBeenCalledWith(response, expect.any(String));
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('sets security headers on /api/auth/clear-session', async () => {
      const { setSecurityHeaders } = await import('@/lib/security/headers');

      const request = createMockRequest('/api/auth/clear-session', { method: 'POST' });

      const response = await proxy(request);

      expect(setSecurityHeaders).toHaveBeenCalledWith(response, expect.any(String));
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('adds the request ID to better-auth catch-all routes', async () => {
      const request = createMockRequest('/api/auth/sign-in', { method: 'POST' });

      const response = await proxy(request);

      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });
  });

  describe('Nonce generation', () => {
    it('forwards a non-empty nonce string as the second argument to setSecurityHeaders', async () => {
      const { setSecurityHeaders } = await import('@/lib/security/headers');

      const request = createMockRequest('/', { cookies: {} });

      const response = await proxy(request);

      expect(setSecurityHeaders).toHaveBeenCalledTimes(1);
      const [, nonceArg] = vi.mocked(setSecurityHeaders).mock.calls[0];
      expect(typeof nonceArg).toBe('string');
      expect((nonceArg as string).length).toBeGreaterThan(0);

      // Finding 4: assert the nonce is end-to-end forwarded to NextResponse.next via
      // x-nonce request header. NextResponse.next({ request: { headers } }) exposes
      // overridden request headers on the response with the prefix
      // 'x-middleware-request-'. If that convention does not fire in the test
      // environment, the header will be null — which is still a clean assertion.
      const forwardedNonce = response.headers.get('x-middleware-request-x-nonce');
      expect(forwardedNonce).toBe(nonceArg as string);
    });
  });
});

describe('proxy — anonymous visitor id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(applyRateLimit).mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.LOG_VISITOR_ID;
    delete process.env.LOG_HTTP_ACCESS;
  });

  it('mints and Set-Cookies a signed visitor id when none is present', async () => {
    const request = createMockRequest('/', { cookies: {} });

    const response = await proxy(request);

    const setCookie = (response as NextResponse).cookies.get(VISITOR_COOKIE_NAME);
    expect(setCookie).toBeDefined();
    // The cookie value must verify under the server's signing key.
    const id = await verifyVisitorId(setCookie?.value);
    expect(id).toBeTruthy();
    // HttpOnly + Lax so it can't be read by client JS or sent cross-site.
    expect(setCookie?.httpOnly).toBe(true);
    expect(setCookie?.sameSite).toBe('lax');
  });

  it('forwards the minted visitor id to server components via x-visitor-id', async () => {
    const request = createMockRequest('/', { cookies: {} });

    const response = await proxy(request);

    const setCookie = (response as NextResponse).cookies.get(VISITOR_COOKIE_NAME);
    const id = await verifyVisitorId(setCookie?.value);
    const forwarded = response.headers.get('x-middleware-request-x-visitor-id');
    expect(forwarded).toBe(id);
  });

  it('reuses a valid cookie without re-issuing Set-Cookie', async () => {
    const cookieValue = await signVisitorId('returning-visitor');
    const request = createMockRequest('/', {
      cookies: { [VISITOR_COOKIE_NAME]: cookieValue },
    });

    const response = await proxy(request);

    // No fresh Set-Cookie for a returning visitor with a valid cookie.
    expect((response as NextResponse).cookies.get(VISITOR_COOKIE_NAME)).toBeUndefined();
    // The existing id is forwarded unchanged.
    expect(response.headers.get('x-middleware-request-x-visitor-id')).toBe('returning-visitor');
  });

  it('strips a spoofed inbound x-visitor-id header (proxy is sole writer)', async () => {
    const cookieValue = await signVisitorId('real-visitor');
    const request = createMockRequest('/', {
      cookies: { [VISITOR_COOKIE_NAME]: cookieValue },
      headers: { 'x-visitor-id': 'attacker-supplied' },
    });

    const response = await proxy(request);

    // The forwarded value comes from the verified cookie, never the header.
    expect(response.headers.get('x-middleware-request-x-visitor-id')).toBe('real-visitor');
    expect(response.headers.get('x-middleware-request-x-visitor-id')).not.toBe('attacker-supplied');
  });

  it('re-mints when the cookie signature is invalid (tamper-resistant)', async () => {
    const request = createMockRequest('/', {
      cookies: { [VISITOR_COOKIE_NAME]: 'forged-id.not-a-real-signature' },
    });

    const response = await proxy(request);

    const setCookie = (response as NextResponse).cookies.get(VISITOR_COOKIE_NAME);
    expect(setCookie).toBeDefined();
    const id = await verifyVisitorId(setCookie?.value);
    expect(id).toBeTruthy();
    expect(id).not.toBe('forged-id');
  });

  it('sets the cookie on a redirect response (journey starts even on redirect)', async () => {
    // Unauthenticated hit on a protected route → redirect to /login.
    const request = createMockRequest('/dashboard', { cookies: {} });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect((response as NextResponse).cookies.get(VISITOR_COOKIE_NAME)).toBeDefined();
  });

  it('issues no cookie and strips the header when tracking is disabled', async () => {
    process.env.LOG_VISITOR_ID = 'false';
    const request = createMockRequest('/', {
      cookies: {},
      headers: { 'x-visitor-id': 'attacker-supplied' },
    });

    const response = await proxy(request);

    expect((response as NextResponse).cookies.get(VISITOR_COOKIE_NAME)).toBeUndefined();
    // Even disabled, a client-supplied header must not reach the app.
    expect(response.headers.get('x-middleware-request-x-visitor-id')).not.toBe('attacker-supplied');
  });

  it('emits a structured access log line when LOG_HTTP_ACCESS=true', async () => {
    process.env.LOG_HTTP_ACCESS = 'true';
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const request = createMockRequest('/pricing', { cookies: {}, method: 'GET' });

    await proxy(request);

    expect(infoSpy).toHaveBeenCalledWith(
      'http_access',
      expect.objectContaining({ method: 'GET', path: '/pricing', visitorId: expect.any(String) })
    );
    infoSpy.mockRestore();
  });

  it('emits no access log line by default (LOG_HTTP_ACCESS unset)', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const request = createMockRequest('/pricing', { cookies: {} });

    await proxy(request);

    expect(infoSpy).not.toHaveBeenCalledWith('http_access', expect.anything());
    infoSpy.mockRestore();
  });
});
