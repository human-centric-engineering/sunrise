/**
 * Accept Invitation Endpoint
 *
 * POST /api/auth/accept-invite
 *
 * Allows users to accept an invitation and set their password.
 * This is a PUBLIC endpoint - authentication is via the invitation token.
 *
 * Flow (Option B Pattern - User created ONCE on acceptance):
 * 1. Validate request body (token, email, password, confirmPassword)
 * 2. Validate invitation token (checks expiration and email match)
 * 3. Fetch invitation metadata (name, role, invitedBy, invitedAt)
 * 4. Create user via better-auth signup endpoint (FIRST TIME - stable User ID)
 * 5. IMMEDIATELY set emailVerified=true AND role (BEFORE session check)
 * 6. Delete invitation token
 * 7. Create explicit session via sign-in endpoint (better-auth sees emailVerified=true)
 * 8. Capture Set-Cookie headers from sign-in response
 * 9. Return success response with forwarded session cookies for auto-login
 *
 * Security:
 * - Token must be valid and not expired
 * - User is created once (no delete/recreate - stable ID)
 * - Password is hashed via better-auth (scrypt)
 * - Email is verified automatically upon acceptance
 * - Session is kept for auto-login (consistent with OAuth invitation flow)
 *
 * Session Cookie Forwarding:
 * - Invitation acceptance requires emailVerified=true BEFORE session creation
 * - We set emailVerified immediately after signup, then call sign-in endpoint
 * - better-auth sets session cookies via /api/auth/sign-in/email (after seeing verified email)
 * - When called from server-side (this API route), cookies are returned to the server
 * - We must explicitly forward these cookies to the client browser for auto-login
 * - Without forwarding, the session exists in DB but browser has no session cookie
 * - This matches the OAuth invitation flow where session cookies are set automatically
 *
 * Note:
 * - Welcome email is sent automatically by database hook (lib/auth/config.ts)
 * - Session is preserved for auto-login (user redirected to dashboard, not login)
 */

import { z } from 'zod';
import { NextRequest } from 'next/server';
import { validateRequestBody } from '@/lib/api/validation';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { handleAPIError, ErrorCodes } from '@/lib/api/errors';
import { acceptInvitationSchema } from '@/lib/validations/user';
import { validateInvitationToken, deleteInvitationToken } from '@/lib/utils/invitation-token';
import { parseInvitationMetadata } from '@/lib/validations/admin';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { env } from '@/lib/env';
import {
  acceptInviteLimiter,
  createRateLimitResponse,
  getRateLimitHeaders,
} from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

/** Schema for better-auth signup success response */
const betterAuthSignupResponseSchema = z.object({
  user: z.object({ id: z.string() }),
});

/** Schema for better-auth error response */
const betterAuthErrorResponseSchema = z.object({
  message: z.string(),
});

/**
 * POST /api/auth/accept-invite
 *
 * Accept an invitation and set user password.
 *
 * @example
 * POST /api/auth/accept-invite
 * {
 *   "token": "abc123...",
 *   "email": "user@example.com",
 *   "password": "SecurePassword123!",
 *   "confirmPassword": "SecurePassword123!"
 * }
 *
 * @returns Success response with message
 * @throws ValidationError if invalid request body
 * @throws APIError if token invalid, user not found, or invitation already accepted
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Check rate limit
    const clientIP = getClientIP(request);
    const rateLimitResult = acceptInviteLimiter.check(clientIP);

    if (!rateLimitResult.success) {
      logger.warn('Accept invite rate limit exceeded', {
        ip: clientIP,
        remaining: rateLimitResult.remaining,
        reset: rateLimitResult.reset,
      });
      return createRateLimitResponse(rateLimitResult);
    }

    // 2. Validate request body
    const body = await validateRequestBody(request, acceptInvitationSchema);
    const { token, email, password } = body;

    logger.info('Invitation acceptance requested', { email });

    // 2. Validate invitation token
    const isValidToken = await validateInvitationToken(email, token);

    if (!isValidToken) {
      logger.warn('Invalid invitation token', { email });
      return errorResponse('Invalid or expired invitation token', {
        code: ErrorCodes.VALIDATION_ERROR,
        status: 400,
      });
    }

    // 3. Get invitation metadata
    const invitation = await prisma.verification.findFirst({
      where: { identifier: `invitation:${email}` },
    });

    if (!invitation || !invitation.metadata) {
      logger.warn('Invitation not found', { email });
      return errorResponse('Invitation not found', {
        code: ErrorCodes.NOT_FOUND,
        status: 404,
      });
    }

    const metadata = parseInvitationMetadata(invitation.metadata);

    if (!metadata) {
      logger.warn('Invalid invitation metadata', { email });
      return errorResponse('Invalid invitation data', {
        code: ErrorCodes.INTERNAL_ERROR,
        status: 500,
      });
    }

    logger.info('Invitation metadata retrieved', { email, role: metadata.role });

    // 4. Create user via better-auth signup (FIRST TIME - stable ID)
    const signupResponse = await fetch(`${env.BETTER_AUTH_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Better-Auth': 'true',
      },
      body: JSON.stringify({
        name: metadata.name,
        email,
        password,
      }),
    });

    if (!signupResponse.ok) {
      const errorBody: unknown = await signupResponse
        .json()
        .catch(() => ({ message: 'Signup failed' }));
      const parsedError = betterAuthErrorResponseSchema.safeParse(errorBody);
      const errorMessage = parsedError.success ? parsedError.data.message : 'Unknown error';
      logger.error('better-auth signup failed', undefined, {
        email,
        error: errorMessage,
      });
      return errorResponse('Failed to create user account', {
        code: ErrorCodes.INTERNAL_ERROR,
        status: 500,
      });
    }

    const signupData: unknown = await signupResponse.json();
    const parsedSignup = betterAuthSignupResponseSchema.safeParse(signupData);
    const newUserId = parsedSignup.success ? parsedSignup.data.user.id : null;

    if (!newUserId) {
      logger.error('better-auth signup returned unexpected response', undefined, { email });
      return errorResponse('Failed to create user account', {
        code: ErrorCodes.INTERNAL_ERROR,
        status: 500,
      });
    }

    logger.info('User created via better-auth', { email, userId: newUserId });

    // 5. IMMEDIATELY set emailVerified=true AND role (BEFORE session check)
    // Accepting invitation proves email ownership
    await prisma.user.update({
      where: { id: newUserId },
      data: {
        emailVerified: true, // Mark as verified
        role: metadata.role && metadata.role !== 'USER' ? metadata.role : undefined,
      },
    });

    logger.info('Email verified and role applied', {
      userId: newUserId,
      role: metadata.role,
    });

    // 6. Delete invitation token
    await deleteInvitationToken(email);

    logger.info('Invitation accepted successfully', { email, userId: newUserId });

    // 7. Create session explicitly (better-auth will now see emailVerified=true)
    const sessionResponse = await fetch(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Better-Auth': 'true',
      },
      body: JSON.stringify({
        email,
        password,
      }),
    });

    if (!sessionResponse.ok) {
      const sessionErrorBody: unknown = await sessionResponse
        .json()
        .catch(() => ({ message: 'Sign-in failed' }));
      const parsedSessionError = betterAuthErrorResponseSchema.safeParse(sessionErrorBody);
      const sessionErrorMessage = parsedSessionError.success
        ? parsedSessionError.data.message
        : 'Unknown error';
      logger.error('better-auth sign-in failed after invitation acceptance', undefined, {
        email,
        userId: newUserId,
        error: sessionErrorMessage,
      });
      return errorResponse('User created but failed to create session', {
        code: ErrorCodes.INTERNAL_ERROR,
        status: 500,
      });
    }

    // Capture Set-Cookie headers from sign-in response
    const setCookieHeaders = sessionResponse.headers.getSetCookie();

    // 8. Return success response with session cookies from better-auth
    // Forward Set-Cookie headers to establish browser session for auto-login
    const response = successResponse(
      {
        message: 'Invitation accepted successfully. Redirecting to dashboard...',
      },
      undefined,
      { status: 200, headers: getRateLimitHeaders(rateLimitResult) }
    );

    // Forward session cookies from better-auth to client browser
    // This enables auto-login after invitation acceptance
    if (setCookieHeaders && setCookieHeaders.length > 0) {
      setCookieHeaders.forEach((cookie) => {
        response.headers.append('Set-Cookie', cookie);
      });

      logger.info('Session cookies forwarded to client', {
        userId: newUserId,
        cookieCount: setCookieHeaders.length,
      });
    }

    return response;
  } catch (error) {
    logger.error('Failed to accept invitation', error);
    return handleAPIError(error);
  }
}
