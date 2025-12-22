import { auth } from '@/lib/auth/config';
import { toNextJsHandler } from 'better-auth/next-js';

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
export const { POST, GET } = toNextJsHandler(auth);
