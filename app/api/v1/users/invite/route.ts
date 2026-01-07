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
 * 4. Check if user account already exists (409 error if exists)
 * 5. Check if invitation already sent (return existing details if exists)
 * 6. Generate invitation token and store in Verification table with metadata
 * 7. Send invitation email
 * 8. Return invitation details (NOT user object)
 *
 * Note: User is NOT created until invitation is accepted (Option B pattern)
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
 * Invites a new user by storing invitation metadata and sending
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
 * @returns Invitation details with token link
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws ValidationError if invalid request body
 * @throws ConflictError if user already exists
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

    // 4. Check if user account already exists (409 error)
    const existingUser = await prisma.user.findUnique({
      where: { email: body.email },
    });

    if (existingUser) {
      return errorResponse('User already exists with this email', {
        code: ErrorCodes.EMAIL_TAKEN,
        status: 409,
      });
    }

    // 5. Check if invitation already sent (return existing details)
    const existingInvitation = await prisma.verification.findFirst({
      where: {
        identifier: `invitation:${body.email}`,
        expiresAt: { gte: new Date() },
      },
    });

    if (existingInvitation) {
      // Return existing invitation details
      const metadata = existingInvitation.metadata as {
        name: string;
        role: string;
        invitedBy: string;
        invitedAt: string;
      };

      // Generate new token for link (for security, don't reuse stored hash)
      const { randomBytes } = await import('crypto');
      const token = randomBytes(32).toString('hex');
      const appUrl =
        env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3000';
      const invitationUrl = `${appUrl}/accept-invite?token=${token}&email=${encodeURIComponent(body.email)}`;

      logger.info('Returning existing invitation', {
        email: body.email,
        invitedAt: metadata.invitedAt,
      });

      return successResponse(
        {
          message: 'Invitation already sent',
          invitation: {
            email: body.email,
            name: metadata.name,
            role: metadata.role,
            invitedAt: metadata.invitedAt,
            expiresAt: existingInvitation.expiresAt.toISOString(),
            link: invitationUrl,
          },
        },
        undefined,
        { status: 200 }
      );
    }

    // 6. Generate invitation token and store with metadata (NO USER CREATION)
    const token = await generateInvitationToken(body.email, {
      name: body.name,
      role: body.role || 'USER',
      invitedBy: session.user.id,
      invitedAt: new Date().toISOString(),
    });

    logger.info('Invitation created', {
      email: body.email,
      role: body.role,
      invitedBy: session.user.id,
    });

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
        email: body.email,
        error: emailResult.error,
      });
    } else {
      logger.info('Invitation email sent', {
        email: body.email,
        emailId: emailResult.id,
      });
    }

    // 8. Return invitation details (NOT user object)
    return successResponse(
      {
        message: 'Invitation sent successfully',
        invitation: {
          email: body.email,
          name: body.name,
          role: body.role || 'USER',
          invitedAt: new Date().toISOString(),
          expiresAt: expiresAt.toISOString(),
          link: invitationUrl,
        },
      },
      undefined,
      { status: 201 }
    );
  } catch (error) {
    return handleAPIError(error);
  }
}
