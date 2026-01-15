import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { generateRequestId } from '@/lib/logging/context';
import { setSecurityHeaders } from '@/lib/security/headers';
import {
  apiLimiter,
  getRateLimitHeaders,
  createRateLimitResponse,
} from '@/lib/security/rate-limit';

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
  // better-auth sets a session cookie named 'better-auth.session_token'
  const sessionToken = request.cookies.get('better-auth.session_token');
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

/**
 * Get client IP from request
 * Handles common proxy headers for deployments behind load balancers
 */
function getClientIP(request: NextRequest): string {
  // Check common proxy headers
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // Take the first IP if there are multiple (client IP is first)
    return forwarded.split(',')[0].trim();
  }

  // NextRequest.ip may be available in some environments
  // Fall back to localhost for development
  return request.headers.get('x-real-ip') ?? '127.0.0.1';
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Generate or extract request ID for distributed tracing
  // Check if request already has an ID (from client propagation)
  const requestId = request.headers.get('x-request-id') || generateRequestId();

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
  if (pathname.startsWith('/api/v1/')) {
    const clientIP = getClientIP(request);
    const rateLimitResult = apiLimiter.check(clientIP);

    if (!rateLimitResult.success) {
      const response = createRateLimitResponse(rateLimitResult);
      // Clone to NextResponse to add request ID
      return new NextResponse(response.body, {
        status: response.status,
        headers: {
          ...Object.fromEntries(response.headers),
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
  const response = NextResponse.next();

  // Add request ID to response headers for tracing
  // This allows clients to:
  // 1. See the request ID in DevTools Network tab
  // 2. Include it in subsequent requests for correlation
  // 3. Use it when reporting errors or issues
  response.headers.set('x-request-id', requestId);

  // Set all security headers (CSP, X-Frame-Options, etc.)
  // NOTE: X-XSS-Protection is intentionally NOT set (deprecated, can cause issues)
  setSecurityHeaders(response);

  // Add rate limit headers for API routes (informational)
  if (pathname.startsWith('/api/v1/')) {
    const clientIP = getClientIP(request);
    const rateLimitResult = apiLimiter.peek(clientIP);
    const headers = getRateLimitHeaders(rateLimitResult);
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
  }

  return response;
}

/**
 * Configure which routes the proxy runs on
 *
 * Match all routes except:
 * - /api/auth/* (better-auth handles these)
 * - /_next/* (Next.js internals)
 * - /static/* (static files)
 * - Favicon, images, etc.
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/auth (better-auth API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (images, etc.)
     */
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
