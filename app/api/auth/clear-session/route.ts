/**
 * Clear Invalid Session Endpoint
 *
 * Route handler to clear invalid session cookies and redirect to login.
 * Used when a user's session cookie exists but their account or session
 * has been deleted, preventing infinite redirect loops.
 *
 * GET /api/auth/clear-session?returnUrl=/dashboard
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { sanitizeRedirectUrl } from '@/lib/security';
import { getRouteLogger } from '@/lib/api/context';

export async function GET(request: NextRequest) {
  const log = await getRouteLogger(request);

  // Get return URL from query params
  const { searchParams } = request.nextUrl;
  const rawReturnUrl = searchParams.get('returnUrl') || '/';
  const baseUrl = request.nextUrl.origin;
  const returnUrl = sanitizeRedirectUrl(rawReturnUrl, baseUrl);

  log.info('Clearing invalid session cookies', { returnUrl });

  // Get cookie store
  const cookieStore = await cookies();

  // Delete all better-auth cookies (session, cached session data, CSRF, OAuth state)
  cookieStore.delete('better-auth.session_token');
  cookieStore.delete('better-auth.session_data');
  cookieStore.delete('better-auth.csrf_token');
  cookieStore.delete('better-auth.state');
  // __Secure- cookies require the Secure attribute in the Set-Cookie header,
  // otherwise browsers silently reject the deletion. Use set() with maxAge: 0
  // instead of delete() to include the required attributes.
  const secureCookieOptions = { path: '/', secure: true, maxAge: 0 } as const;
  cookieStore.set('__Secure-better-auth.session_token', '', secureCookieOptions);
  cookieStore.set('__Secure-better-auth.session_data', '', secureCookieOptions);
  cookieStore.set('__Secure-better-auth.csrf_token', '', secureCookieOptions);
  cookieStore.set('__Secure-better-auth.state', '', secureCookieOptions);

  // Construct login URL using forwarded headers to preserve the original origin.
  // In Route Handlers, request.url is the server-local URL (e.g. http://localhost:3000)
  // which differs from the actual client-facing URL when behind a reverse proxy (e.g. ngrok).
  const proto =
    request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
  const host = request.headers.get('host') || request.nextUrl.host;
  const loginUrl = new URL('/login', `${proto}://${host}`);
  loginUrl.searchParams.set('callbackUrl', returnUrl);

  // Redirect to login
  log.info('Session cleared, redirecting to login', { loginUrl: loginUrl.toString() });
  return NextResponse.redirect(loginUrl);
}
