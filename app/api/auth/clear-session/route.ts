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

export async function GET(request: NextRequest) {
  // Get return URL from query params
  const { searchParams } = request.nextUrl;
  const rawReturnUrl = searchParams.get('returnUrl') || '/';
  const baseUrl = request.nextUrl.origin;
  const returnUrl = sanitizeRedirectUrl(rawReturnUrl, baseUrl);

  // Get cookie store
  const cookieStore = await cookies();

  // Delete all better-auth cookies (session, cached session data, CSRF, OAuth state)
  cookieStore.delete('better-auth.session_token');
  cookieStore.delete('better-auth.session_data');
  cookieStore.delete('better-auth.csrf_token');
  cookieStore.delete('better-auth.state');
  cookieStore.delete('__Secure-better-auth.session_token');
  cookieStore.delete('__Secure-better-auth.session_data');
  cookieStore.delete('__Secure-better-auth.csrf_token');
  cookieStore.delete('__Secure-better-auth.state');

  // Construct login URL with callback
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('callbackUrl', returnUrl);

  // Redirect to login
  return NextResponse.redirect(loginUrl);
}
