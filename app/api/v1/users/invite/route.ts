/**
 * User Invitation Endpoint (Admin Only)
 *
 * POST /api/v1/users/invite - Invite a new user (sends invitation email)
 *
 * Authentication: Required (Admin role only)
 *
 * POST Request Body:
 *   - name: User's full name (required)
 *   - email: User's email address (required, must be unique)
 *   - role: User's role (optional, defaults to USER)
 *
 * Flow:
 * 1. Authenticate user (require session)
 * 2. Authorize user (require ADMIN role)
 * 3. Validate request body
 * 4. Check if user already exists
 * 5. Create user without password (emailVerified=false)
 * 6. Generate invitation token
 * 7. Send invitation email
 * 8. Return created user with status: 'invited'
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { UnauthorizedError, ForbiddenError, handleAPIError, ErrorCodes } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { inviteUserSchema } from '@/lib/validations/user';
import { generateInvitationToken } from '@/lib/utils/invitation-token';
import { sendEmail } from '@/lib/email/send';
import InvitationEmail from '@/emails/invitation';
import { logger } from '@/lib/logging';
import { env } from '@/lib/env';

/**
 * POST /api/v1/users/invite
 *
 * Invites a new user by creating an account without password and sending
 * an invitation email with a secure token to complete registration.
 *
 * @example
 * POST /api/v1/users/invite
 * {
 *   "name": "John Doe",
 *   "email": "john@example.com",
 *   "role": "USER"
 * }
 *
 * @returns Created user object with status: 'invited'
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws ValidationError if invalid request body
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate user (require session)
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    // 2. Authorize user (require ADMIN role)
    if (session.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }

    // 3. Validate request body
    const body = await validateRequestBody(request, inviteUserSchema);

    // 4. Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: body.email },
    });

    if (existingUser) {
      return errorResponse('Email already in use', {
        code: ErrorCodes.EMAIL_TAKEN,
        status: 400,
      });
    }

    // 5. Create user without password (emailVerified=false)
    const newUser = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        emailVerified: false,
        role: body.role,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        emailVerified: true,
        createdAt: true,
      },
    });

    logger.info('User created via invitation', {
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
      invitedBy: session.user.id,
    });

    // 6. Generate invitation token
    const token = await generateInvitationToken(body.email);

    // 7. Send invitation email
    const appUrl =
      env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3000';
    const invitationUrl = `${appUrl}/accept-invite?token=${token}&email=${encodeURIComponent(body.email)}`;

    // Calculate expiration for email (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const emailResult = await sendEmail({
      to: body.email,
      subject: `You've been invited to join Sunrise`,
      react: InvitationEmail({
        inviterName: session.user.name || 'Administrator',
        inviteeName: body.name,
        inviteeEmail: body.email,
        invitationUrl,
        expiresAt,
      }),
    });

    // Email sending failure should NOT fail the request (just log warning)
    if (!emailResult.success) {
      logger.warn('Failed to send invitation email', {
        userId: newUser.id,
        email: newUser.email,
        error: emailResult.error,
      });
    } else {
      logger.info('Invitation email sent', {
        userId: newUser.id,
        email: newUser.email,
        emailId: emailResult.id,
      });
    }

    // 8. Return created user with status: 'invited'
    return successResponse(
      {
        ...newUser,
        status: 'invited',
      },
      undefined,
      { status: 201 }
    );
  } catch (error) {
    return handleAPIError(error);
  }
}
