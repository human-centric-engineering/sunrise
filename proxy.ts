import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { generateRequestId } from '@/lib/logging/context';

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

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authenticated = isAuthenticated(request);

  // Generate or extract request ID for distributed tracing
  // Check if request already has an ID (from client propagation)
  const requestId = request.headers.get('x-request-id') || generateRequestId();

  // Check if the current route is protected
  const isProtectedRoute = protectedRoutes.some((route) => pathname.startsWith(route));

  // Check if the current route is an auth page
  const isAuthRoute = authRoutes.some((route) => pathname.startsWith(route));

  // Redirect unauthenticated users away from protected routes
  if (isProtectedRoute && !authenticated) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    const redirectResponse = NextResponse.redirect(loginUrl);
    // Add request ID to redirect response
    redirectResponse.headers.set('x-request-id', requestId);
    return redirectResponse;
  }

  // Redirect authenticated users away from auth pages
  if (isAuthRoute && authenticated) {
    const redirectResponse = NextResponse.redirect(new URL('/dashboard', request.url));
    // Add request ID to redirect response
    redirectResponse.headers.set('x-request-id', requestId);
    return redirectResponse;
  }

  // Add security headers to all responses
  const response = NextResponse.next();

  // Add request ID to response headers for tracing
  // This allows clients to:
  // 1. See the request ID in DevTools Network tab
  // 2. Include it in subsequent requests for correlation
  // 3. Use it when reporting errors or issues
  response.headers.set('x-request-id', requestId);

  // Prevent clickjacking attacks
  response.headers.set('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Enable XSS filter
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Control referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy - disable unnecessary features
  response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Force HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
