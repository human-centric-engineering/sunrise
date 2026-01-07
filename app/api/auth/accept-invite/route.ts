/**
 * Accept Invitation Endpoint
 *
 * POST /api/auth/accept-invite
 *
 * Allows users to accept an invitation and set their password.
 * This is a PUBLIC endpoint - authentication is via the invitation token.
 *
 * Flow:
 * 1. Validate request body (token, email, password, confirmPassword)
 * 2. Validate invitation token (checks expiration and email match)
 * 3. Find user by email
 * 4. Check user hasn't already accepted (no password set)
 * 5. Set password using better-auth signup endpoint delegation
 * 6. Delete invitation token
 * 7. Return success response
 *
 * Security:
 * - Token must be valid and not expired
 * - User must not have a password already (prevents re-acceptance)
 * - Password is hashed via better-auth (scrypt)
 * - Email is verified automatically upon acceptance
 */

import { NextRequest } from 'next/server';
import { validateRequestBody } from '@/lib/api/validation';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { handleAPIError, ErrorCodes } from '@/lib/api/errors';
import { acceptInvitationSchema } from '@/lib/validations/user';
import { validateInvitationToken, deleteInvitationToken } from '@/lib/utils/invitation-token';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

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

    // 3. Find user by email with their accounts
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: {
        accounts: {
          where: { providerId: 'credential' },
        },
      },
    });

    if (!user) {
      logger.warn('User not found for invitation', { email });
      return errorResponse('User not found', {
        code: ErrorCodes.NOT_FOUND,
        status: 404,
      });
    }

    // 4. Check if user already has a password (invitation already accepted)
    const credentialAccount = user.accounts.find((account) => account.providerId === 'credential');

    if (credentialAccount?.password) {
      logger.warn('Invitation already accepted', { email, userId: user.id });
      return errorResponse('Invitation already accepted', {
        code: ErrorCodes.VALIDATION_ERROR,
        status: 400,
      });
    }

    // 5. Create credential account with password via better-auth signup
    // Since user already exists (created during invitation), we need to:
    // a) Delete the existing user
    // b) Re-create via signup (which will hash password correctly)
    // c) This ensures password compatibility with better-auth login

    // Store user data before deletion
    const userData = {
      name: user.name,
      email: user.email,
      role: user.role,
      image: user.image,
    };

    // Delete existing user (and cascading sessions/accounts)
    await prisma.user.delete({
      where: { id: user.id },
    });

    // Re-create user via better-auth signup endpoint
    const signupResponse = await fetch(`${process.env.BETTER_AUTH_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: userData.name,
        email: userData.email,
        password: password,
      }),
    });

    if (!signupResponse.ok) {
      const error = (await signupResponse.json().catch(() => ({ message: 'Signup failed' }))) as {
        message?: string;
      };
      logger.error('Signup via better-auth failed', undefined, {
        email,
        error: error.message ?? 'Unknown error',
      });
      throw new Error(error.message ?? 'Failed to set password');
    }

    const signupData = (await signupResponse.json()) as {
      user: { id: string };
      session?: { token: string };
    };
    const newUserId = signupData.user.id;

    // Update role if it was different from default
    if (userData.role && userData.role !== 'USER') {
      await prisma.user.update({
        where: { id: newUserId },
        data: { role: userData.role },
      });
    }

    // Update image if it existed
    if (userData.image) {
      await prisma.user.update({
        where: { id: newUserId },
        data: { image: userData.image },
      });
    }

    // Mark email as verified (accepting invitation verifies email)
    await prisma.user.update({
      where: { id: newUserId },
      data: { emailVerified: true },
    });

    // Clean up the session created by signup (we don't want to auto-login)
    if (signupData.session) {
      await prisma.session
        .delete({
          where: { token: signupData.session.token },
        })
        .catch(() => {
          // Ignore if session doesn't exist or was already deleted
        });
    }

    // 6. Delete invitation token
    await deleteInvitationToken(email);

    logger.info('Invitation accepted successfully', { email, userId: newUserId });

    // 7. Return success response
    return successResponse(
      {
        message: 'Invitation accepted successfully. You can now sign in.',
        email: userData.email,
      },
      undefined,
      { status: 200 }
    );
  } catch (error) {
    logger.error('Failed to accept invitation', error);
    return handleAPIError(error);
  }
}
