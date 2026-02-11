import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { generateRequestId } from '@/lib/logging/context';
import { setSecurityHeaders } from '@/lib/security/headers';
import { getClientIP } from '@/lib/security/ip';
import {
  apiLimiter,
  adminLimiter,
  authLimiter,
  getRateLimitHeaders,
  createRateLimitResponse,
} from '@/lib/security/rate-limit';
import type { RateLimitResult } from '@/lib/security/rate-limit';

/**
 * Next.js Proxy
 *
 * Runs before every request to:
 * 1. Generate/propagate request IDs for distributed tracing
 * 2. Check authentication and handle protected routes
 * 3. Add security headers to all responses
 *
 * Request IDs enable tracing user actions across:
 * - Client (browser logs)
 * - Server (API route logs)
 * - Database operations
 * - Error tracking systems
 *
 * Protected routes:
 * - /dashboard/*
 * - /settings/*
 * - /profile/*
 * - Any route in the (protected) route group
 *
 * Public routes:
 * - /login
 * - /signup
 * - /
 * - /api/auth/* (better-auth endpoints)
 */

/**
 * Define which routes require authentication
 */
const protectedRoutes = ['/dashboard', '/settings', '/profile'];

/**
 * Define which routes are auth pages (login, signup, etc.)
 * Authenticated users will be redirected away from these
 */
const authRoutes = ['/login', '/signup', '/reset-password'];

/**
 * Check if a user is authenticated by looking for the better-auth session cookie
 */
function isAuthenticated(request: NextRequest): boolean {
  // better-auth uses 'better-auth.session_token' over HTTP
  // and '__Secure-better-auth.session_token' over HTTPS
  const sessionToken =
    request.cookies.get('better-auth.session_token') ||
    request.cookies.get('__Secure-better-auth.session_token');
  return !!sessionToken;
}

/**
 * Validate origin for state-changing requests (additional CSRF protection)
 *
 * Better-auth provides CSRF protection via tokens, but this adds defense-in-depth
 * by validating that the Origin header matches the host for state-changing requests.
 *
 * @param request - Incoming request
 * @returns Whether the origin is valid (or request is safe)
 */
function validateOrigin(request: NextRequest): boolean {
  // Only validate state-changing methods
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
    return true;
  }

  const origin = request.headers.get('origin');
  const host = request.headers.get('host');

  // No origin header = same-origin request or direct API call (allowed)
  if (!origin) return true;

  // Origin must match host
  try {
    const originUrl = new URL(origin);
    return originUrl.host === host;
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest): NextResponse | Response {
  const { pathname } = request.nextUrl;

  // Generate or extract request ID for distributed tracing
  // Check if request already has an ID (from client propagation)
  const requestId = request.headers.get('x-request-id') || generateRequestId();

  // Generate a per-request nonce for CSP inline script allowlisting.
  // Forwarded to layouts via x-nonce request header so server components
  // can add it to any inline <script> tags they render.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  // ==========================================================================
  // Security: Origin validation (CSRF protection for state-changing requests)
  // ==========================================================================
  if (!validateOrigin(request)) {
    return new NextResponse(
      JSON.stringify({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid request origin',
        },
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
      }
    );
  }

  // ==========================================================================
  // Security: Rate limiting for API routes
  // ==========================================================================
  // Store the result so we can reuse it for response headers (avoids a
  // separate peek() call which would show post-consumption counts).
  let apiRateLimitResult: RateLimitResult | null = null;

  if (pathname.startsWith('/api/v1/')) {
    const clientIP = getClientIP(request);

    // Admin endpoints get a tighter limit (30/min) on top of the global API limit
    if (pathname.startsWith('/api/v1/admin/')) {
      const adminResult = adminLimiter.check(clientIP);
      if (!adminResult.success) {
        const rateLimitResponse = createRateLimitResponse(adminResult);
        return new NextResponse(rateLimitResponse.body, {
          status: rateLimitResponse.status,
          headers: {
            ...Object.fromEntries(rateLimitResponse.headers),
            'x-request-id': requestId,
          },
        });
      }
    }

    apiRateLimitResult = apiLimiter.check(clientIP);

    if (!apiRateLimitResult.success) {
      const rateLimitResponse = createRateLimitResponse(apiRateLimitResult);
      // Clone to NextResponse to add request ID
      return new NextResponse(rateLimitResponse.body, {
        status: rateLimitResponse.status,
        headers: {
          ...Object.fromEntries(rateLimitResponse.headers),
          'x-request-id': requestId,
        },
      });
    }
  }

  // Credential-based auth endpoints get rate limited (5/min) to prevent brute-force attacks.
  // Only targets sign-in, sign-up, forgot/reset-password — NOT session reads, sign-out, or OAuth callbacks.
  const AUTH_RATE_LIMITED_PATHS = [
    '/api/auth/sign-in',
    '/api/auth/sign-up',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
  ];
  if (AUTH_RATE_LIMITED_PATHS.some((p) => pathname.startsWith(p))) {
    const clientIP = getClientIP(request);
    const authResult = authLimiter.check(clientIP);
    if (!authResult.success) {
      const rateLimitResponse = createRateLimitResponse(authResult);
      return new NextResponse(rateLimitResponse.body, {
        status: rateLimitResponse.status,
        headers: {
          ...Object.fromEntries(rateLimitResponse.headers),
          'x-request-id': requestId,
        },
      });
    }
  }

  // ==========================================================================
  // Authentication: Check protected/auth routes
  // ==========================================================================
  const authenticated = isAuthenticated(request);

  // Check if the current route is protected
  const isProtectedRoute = protectedRoutes.some((route) => pathname.startsWith(route));

  // Check if the current route is an auth page
  const isAuthRoute = authRoutes.some((route) => pathname.startsWith(route));

  // Redirect unauthenticated users away from protected routes
  if (isProtectedRoute && !authenticated) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    const redirectResponse = NextResponse.redirect(loginUrl);
    redirectResponse.headers.set('x-request-id', requestId);
    return redirectResponse;
  }

  // Redirect authenticated users away from auth pages
  if (isAuthRoute && authenticated) {
    const redirectResponse = NextResponse.redirect(new URL('/dashboard', request.url));
    redirectResponse.headers.set('x-request-id', requestId);
    return redirectResponse;
  }

  // ==========================================================================
  // Response: Add security headers and request ID
  // ==========================================================================

  // Forward nonce to server components via request header so layouts can
  // add it to inline <script> tags (e.g. theme detection script in root layout).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Add request ID to response headers for tracing
  // This allows clients to:
  // 1. See the request ID in DevTools Network tab
  // 2. Include it in subsequent requests for correlation
  // 3. Use it when reporting errors or issues
  response.headers.set('x-request-id', requestId);

  // Set all security headers (CSP, X-Frame-Options, etc.)
  // Nonce is included in script-src so Next.js hydration scripts are allowed.
  // NOTE: X-XSS-Protection is intentionally NOT set (deprecated, can cause issues)
  setSecurityHeaders(response, nonce);

  // Add rate limit headers for API routes (informational)
  // Reuse the result from check() above — no separate peek() needed.
  if (apiRateLimitResult) {
    const rateLimitHeaders = getRateLimitHeaders(apiRateLimitResult);
    for (const [key, value] of Object.entries(rateLimitHeaders)) {
      response.headers.set(key, value);
    }
  }

  return response;
}

/**
 * Configure which routes the proxy runs on
 *
 * Match all routes except:
 * - /_next/* (Next.js internals)
 * - /static/* (static files)
 * - Favicon, images, etc.
 *
 * NOTE: /api/auth/* is no longer excluded. Custom auth routes
 * (send-verification-email, accept-invite, clear-session) need
 * security headers and request ID tracking from the proxy.
 * better-auth's catch-all handler works fine with the proxy
 * since it just adds headers via NextResponse.next().
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (images, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
