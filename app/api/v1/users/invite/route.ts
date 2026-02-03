/**
 * User Invitation Endpoint (Admin Only)
 *
 * POST /api/v1/users/invite - Invite a new user (sends invitation email)
 * POST /api/v1/users/invite?resend=true - Resend invitation with new token
 *
 * Authentication: Required (Admin role only)
 *
 * Query Parameters:
 *   - resend: Set to 'true' to regenerate token and resend email for existing invitation
 *
 * POST Request Body:
 *   - name: User's full name (required)
 *   - email: User's email address (required, must be unique)
 *   - role: User's role (optional, defaults to USER)
 *
 * Response emailStatus values:
 *   - 'sent': Email was sent successfully
 *   - 'failed': Email sending failed (invitation still created)
 *   - 'disabled': Email service not configured
 *   - 'pending': Existing invitation found, no new email sent (use ?resend=true)
 *
 * Flow:
 * 1. Authenticate user (require session)
 * 2. Authorize user (require ADMIN role)
 * 3. Validate request body
 * 4. Parse resend query parameter
 * 5. Check if user account already exists (409 error if exists)
 * 6. Check if invitation already exists:
 *    - If exists and resend=false: Return 200 with 'pending' status (NO link)
 *    - If exists and resend=true: Delete old, create new token, send email
 *    - If not exists: Create new invitation
 * 7. Generate/regenerate invitation token
 * 8. Send invitation email
 * 9. Return invitation details (NOT user object)
 *
 * Note: User is NOT created until invitation is accepted (Option B pattern)
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { ErrorCodes } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { inviteUserSchema } from '@/lib/validations/user';
import {
  generateInvitationToken,
  getValidInvitation,
  updateInvitationToken,
} from '@/lib/utils/invitation-token';
import { sendEmail } from '@/lib/email/send';
import InvitationEmail from '@/emails/invitation';
import { logger } from '@/lib/logging';
import { env } from '@/lib/env';
import { inviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

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
export const POST = withAdminAuth(async (request, session) => {
  // 1. Check invite rate limit (prevents email bombing)
  const clientIP = getClientIP(request);
  const rateLimitResult = inviteLimiter.check(clientIP);

  if (!rateLimitResult.success) {
    logger.warn('Invite rate limit exceeded', {
      ip: clientIP,
      adminId: session.user.id,
      remaining: rateLimitResult.remaining,
      reset: rateLimitResult.reset,
    });
    return createRateLimitResponse(rateLimitResult);
  }

  // 3. Validate request body
  const body = await validateRequestBody(request, inviteUserSchema);

  // 4. Parse resend query parameter
  const url = new URL(request.url);
  const resend = url.searchParams.get('resend') === 'true';

  // 5. Check if user account already exists (409 error)
  const existingUser = await prisma.user.findUnique({
    where: { email: body.email },
  });

  if (existingUser) {
    return errorResponse('User already exists with this email', {
      code: ErrorCodes.EMAIL_TAKEN,
      status: 409,
    });
  }

  // 6. Check if valid (non-expired) invitation already exists
  const existingInvitation = await getValidInvitation(body.email);

  if (existingInvitation && !resend) {
    // Return existing invitation details WITHOUT a link (can't generate valid one)
    // Admin must use ?resend=true to send a new email with valid link
    logger.info('Existing invitation found, not resending', {
      email: body.email,
      invitedAt: existingInvitation.metadata.invitedAt,
      expiresAt: existingInvitation.expiresAt.toISOString(),
    });

    return successResponse(
      {
        message: 'Invitation already pending. Use ?resend=true to send a new invitation email.',
        invitation: {
          email: body.email,
          name: existingInvitation.metadata.name,
          role: existingInvitation.metadata.role,
          invitedAt: existingInvitation.metadata.invitedAt,
          expiresAt: existingInvitation.expiresAt.toISOString(),
          // NO link - can't generate a valid one without resending
        },
        emailStatus: 'pending' as const,
      },
      undefined,
      { status: 200 }
    );
  }

  // 7. Generate or regenerate invitation token
  const invitationMetadata = {
    name: body.name,
    role: body.role || 'USER',
    invitedBy: session.user.id,
    invitedAt: new Date().toISOString(),
  };

  // Use updateInvitationToken for resend (deletes old, creates new)
  // Use generateInvitationToken for new invitations
  const token = existingInvitation
    ? await updateInvitationToken(body.email, invitationMetadata)
    : await generateInvitationToken(body.email, invitationMetadata);

  logger.info(existingInvitation ? 'Invitation resent' : 'Invitation created', {
    email: body.email,
    role: body.role,
    invitedBy: session.user.id,
    isResend: !!existingInvitation,
  });

  // 8. Send invitation email
  const appUrl = env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3000';
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
      emailStatus: emailResult.status,
    });
  } else {
    logger.info('Invitation email sent', {
      email: body.email,
      emailId: emailResult.id,
      emailStatus: emailResult.status,
    });
  }

  // 9. Return invitation details (NOT user object)
  // Message varies based on email delivery status and whether this is a resend
  const actionWord = existingInvitation ? 'resent' : 'sent';
  const message =
    emailResult.status === 'sent'
      ? `Invitation ${actionWord} successfully`
      : emailResult.status === 'failed'
        ? `Invitation ${existingInvitation ? 'regenerated' : 'created'} but email failed to send`
        : `Invitation ${existingInvitation ? 'regenerated' : 'created'} (email service not configured)`;

  return successResponse(
    {
      message,
      invitation: {
        email: body.email,
        name: body.name,
        role: body.role || 'USER',
        invitedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        link: invitationUrl,
      },
      emailStatus: emailResult.status,
    },
    undefined,
    { status: 201 }
  );
});
