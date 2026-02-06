import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { toNextJsHandler } from 'better-auth/next-js';
import { getRouteLogger } from '@/lib/api/context';

/**
 * Better Auth API Route Handler
 *
 * This catch-all route handles all authentication requests:
 * - POST /api/auth/sign-up - User registration
 * - POST /api/auth/sign-in/email - Email/password sign in
 * - POST /api/auth/sign-in/social - OAuth sign in (Google)
 * - POST /api/auth/sign-out - Sign out
 * - GET /api/auth/session - Get current session
 * - GET /api/auth/callback/google - OAuth callback
 * - And more...
 *
 * Better Auth automatically handles all routes, validation, and responses.
 */
const { POST: betterAuthPOST, GET: betterAuthGET } = toNextJsHandler(auth);

export async function POST(request: NextRequest) {
  const log = await getRouteLogger(request);
  const authPath = request.nextUrl.pathname.replace('/api/auth/', '');
  log.info('Auth POST request', { authPath });

  try {
    const response = await betterAuthPOST(request);
    log.info('Auth POST completed', { authPath, status: response.status });
    return response;
  } catch (error) {
    log.error('Auth POST failed', error, { authPath });
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const log = await getRouteLogger(request);
  const authPath = request.nextUrl.pathname.replace('/api/auth/', '');
  log.info('Auth GET request', { authPath });

  try {
    const response = await betterAuthGET(request);
    log.info('Auth GET completed', { authPath, status: response.status });
    return response;
  } catch (error) {
    log.error('Auth GET failed', error, { authPath });
    throw error;
  }
}
