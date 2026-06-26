import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { generateRequestId } from '@/lib/logging/context';
import { logger } from '@/lib/logging';
import {
  VISITOR_COOKIE_NAME,
  VISITOR_HEADER_NAME,
  isVisitorTrackingEnabled,
  isHttpAccessLogEnabled,
  issueVisitorId,
  verifyVisitorId,
  visitorCookieOptions,
} from '@/lib/logging/visitor-id';
import { setSecurityHeaders } from '@/lib/security/headers';
import { applyRateLimit } from '@/lib/security/rate-limit-middleware';

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

export async function proxy(request: NextRequest): Promise<NextResponse | Response> {
  const { pathname } = request.nextUrl;

  // Generate or extract request ID for distributed tracing
  // Check if request already has an ID (from client propagation)
  const requestId = request.headers.get('x-request-id') || generateRequestId();

  // Generate a per-request nonce for CSP inline script allowlisting.
  // Forwarded to layouts via x-nonce request header so server components
  // can add it to any inline <script> tags they render.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  // ==========================================================================
  // Observability: durable anonymous visitor id
  // ==========================================================================
  // Resolve (or mint) a signed visitor id so server logs can correlate an
  // anonymous visitor's journey across requests, where `requestId` cannot.
  // The id is forwarded to server components via the `x-visitor-id` request
  // header (below) and folded into the log context by `getRequestContext`.
  // `visitorCookieValue` is non-null only when we minted a fresh id, so a
  // returning visitor with a valid cookie incurs no `Set-Cookie`.
  let visitorId: string | null = null;
  let visitorCookieValue: string | null = null;
  if (isVisitorTrackingEnabled()) {
    visitorId = await verifyVisitorId(request.cookies.get(VISITOR_COOKIE_NAME)?.value);
    if (!visitorId) {
      const issued = await issueVisitorId();
      visitorId = issued.id;
      visitorCookieValue = issued.cookieValue;
    }
  }

  // Set the freshly minted visitor cookie on whichever response we return
  // (passthrough, redirect, or block) so the journey starts on the first
  // request regardless of outcome. No-op for returning visitors.
  const setVisitorCookie = (response: NextResponse): NextResponse => {
    if (visitorCookieValue) {
      response.cookies.set(VISITOR_COOKIE_NAME, visitorCookieValue, visitorCookieOptions());
    }
    return response;
  };

  // Optional per-request access log (default off, behind LOG_HTTP_ACCESS).
  // Makes anonymous navigation visible server-side. The final response
  // status is not available to the proxy for passthrough requests, so the
  // line carries the request shape + correlation keys only.
  if (isHttpAccessLogEnabled()) {
    logger.info('http_access', {
      requestId,
      visitorId: visitorId ?? undefined,
      method: request.method,
      path: pathname,
    });
  }

  // ==========================================================================
  // Security: Origin validation (CSRF protection for state-changing requests)
  // ==========================================================================
  if (!validateOrigin(request)) {
    return setVisitorCookie(
      new NextResponse(
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
      )
    );
  }

  // ==========================================================================
  // Security: Rate limiting via central policy table
  // ==========================================================================
  // The policy table at `lib/security/rate-limit-policy.ts` declares which
  // tier + key strategy applies to which path. The dispatcher resolves the
  // matching rule, builds a token, calls the limiter, and returns a 429
  // response if the cap is exceeded. Anonymous, no-rule, and bypass paths
  // return null and we fall through.
  const rateLimitResponse = await applyRateLimit(request);
  if (rateLimitResponse) {
    // Re-wrap so the request ID propagates to the client alongside the
    // standard rate-limit envelope and headers from `createRateLimitResponse`.
    return setVisitorCookie(
      new NextResponse(rateLimitResponse.body, {
        status: rateLimitResponse.status,
        headers: {
          ...Object.fromEntries(rateLimitResponse.headers),
          'x-request-id': requestId,
        },
      })
    );
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
    return setVisitorCookie(redirectResponse);
  }

  // Redirect authenticated users away from auth pages
  if (isAuthRoute && authenticated) {
    const redirectResponse = NextResponse.redirect(new URL('/dashboard', request.url));
    redirectResponse.headers.set('x-request-id', requestId);
    return setVisitorCookie(redirectResponse);
  }

  // ==========================================================================
  // Response: Add security headers and request ID
  // ==========================================================================

  // Forward nonce to server components via request header so layouts can
  // add it to inline <script> tags (e.g. theme detection script in root layout).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  // Forward the verified visitor id to server components. The proxy is the
  // sole writer of this header: set it from the verified/minted id, or
  // strip any client-supplied value so a visitor can't spoof another's id.
  if (visitorId) {
    requestHeaders.set(VISITOR_HEADER_NAME, visitorId);
  } else {
    requestHeaders.delete(VISITOR_HEADER_NAME);
  }

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

  return setVisitorCookie(response);
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
