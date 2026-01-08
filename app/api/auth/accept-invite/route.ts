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
 * 5. Capture Set-Cookie headers from better-auth response
 * 6. Update role if non-default
 * 7. Mark email as verified
 * 8. Delete invitation token
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
 * - better-auth sets session cookies when creating users via /api/auth/sign-up/email
 * - When called from server-side (this API route), cookies are returned to the server
 * - We must explicitly forward these cookies to the client browser for auto-login
 * - Without forwarding, the session exists in DB but browser has no session cookie
 * - This matches the OAuth invitation flow where session cookies are set automatically
 *
 * Note:
 * - Welcome email is sent automatically by database hook (lib/auth/config.ts)
 * - Session is preserved for auto-login (user redirected to dashboard, not login)
 */

import { NextRequest } from 'next/server';
import { validateRequestBody } from '@/lib/api/validation';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { handleAPIError, ErrorCodes } from '@/lib/api/errors';
import { acceptInvitationSchema } from '@/lib/validations/user';
import { validateInvitationToken, deleteInvitationToken } from '@/lib/utils/invitation-token';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { env } from '@/lib/env';

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
    // 1. Validate request body
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

    const metadata = invitation.metadata as {
      name: string;
      role: string;
      invitedBy: string;
      invitedAt: string;
    };

    logger.info('Invitation metadata retrieved', { email, metadata });

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
      const error = (await signupResponse.json().catch(() => ({ message: 'Signup failed' }))) as {
        message?: string;
      };
      logger.error('better-auth signup failed', undefined, {
        email,
        error: error.message ?? 'Unknown error',
      });
      return errorResponse('Failed to create user account', {
        code: ErrorCodes.INTERNAL_ERROR,
        status: 500,
      });
    }

    // Capture Set-Cookie headers from better-auth response to forward to client
    // This is critical for auto-login - the session cookies must reach the browser
    const setCookieHeaders = signupResponse.headers.getSetCookie();

    const signupData = (await signupResponse.json()) as {
      user: { id: string };
      session?: { token: string };
    };
    const newUserId = signupData.user.id;

    logger.info('User created via better-auth', { email, userId: newUserId });

    // 5. Update role if non-default
    if (metadata.role && metadata.role !== 'USER') {
      await prisma.user.update({
        where: { id: newUserId },
        data: { role: metadata.role },
      });
      logger.info('User role updated', { userId: newUserId, role: metadata.role });
    }

    // 6. Mark email as verified (accepting invitation verifies email)
    await prisma.user.update({
      where: { id: newUserId },
      data: { emailVerified: true },
    });

    // 7. Delete invitation token
    await deleteInvitationToken(email);

    logger.info('Invitation accepted successfully', { email, userId: newUserId });

    // 9. Return success response with session cookies from better-auth
    // Forward Set-Cookie headers to establish browser session for auto-login
    const response = successResponse(
      {
        message: 'Invitation accepted successfully. Redirecting to dashboard...',
      },
      undefined,
      { status: 200 }
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
