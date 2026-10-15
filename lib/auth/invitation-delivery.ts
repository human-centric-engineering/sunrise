/**
 * Issue an invitation and email it — the part every invite route shares.
 *
 * Who may invite, into what, and as what is each route's decision, made
 * before it calls this: `POST /api/v1/users/invite` (the platform's, any org
 * and any platform role) and `POST /api/v1/orgs/[id]/invitations` (an org's
 * own admins, into that org only, §111 t-813). This stores the token,
 * replacing a pending one when the route is re-sending, and sends the email.
 * A failed send does not fail the invitation: the token is stored and the
 * link is returned to the route. Whether the route hands it to the inviter is
 * the route's decision. The platform route does, so a platform admin can pass
 * it on by hand. The org route does not: the token is all acceptance asks
 * for, so it reaches the invitee by email only.
 */
import { BRAND } from '@/lib/brand';
import { env } from '@/lib/env';
import { sendEmail, type EmailStatus } from '@/lib/email/send';
import { resolveEmailTemplate } from '@/lib/email/registry';
import {
  generateInvitationToken,
  updateInvitationToken,
  type InvitationMetadata,
} from '@/lib/utils/invitation-token';
import type { Logger } from '@/lib/logging';

export interface DeliverInvitationInput {
  email: string;
  name: string;
  metadata: InvitationMetadata;
  /** A pending invitation exists for this email and is being re-sent. */
  isResend: boolean;
  inviterName: string;
  log: Logger;
}

export interface DeliveredInvitation {
  link: string;
  expiresAt: Date;
  emailStatus: EmailStatus;
  message: string;
}

export async function deliverInvitation({
  email,
  name,
  metadata,
  isResend,
  inviterName,
  log,
}: DeliverInvitationInput): Promise<DeliveredInvitation> {
  // A resend deletes the old token and creates a new one.
  const token = isResend
    ? await updateInvitationToken(email, metadata)
    : await generateInvitationToken(email, metadata);

  const appUrl = env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3000';
  const link = `${appUrl}/accept-invite?token=${token}&email=${encodeURIComponent(email)}`;

  // Calculate expiration for email (7 days from now)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const emailResult = await sendEmail({
    to: email,
    subject: `You've been invited to join ${BRAND.name}`,
    react: resolveEmailTemplate('invitation', {
      inviterName,
      inviteeName: name,
      inviteeEmail: email,
      invitationUrl: link,
      expiresAt,
    }),
  });

  // Email sending failure should NOT fail the request (just log warning)
  if (!emailResult.success) {
    log.warn('Failed to send invitation email', {
      email,
      error: emailResult.error,
      deliveryStatus: emailResult.status,
    });
  } else {
    log.info('Invitation email sent', {
      email,
      messageId: emailResult.id,
      deliveryStatus: emailResult.status,
    });
  }

  // Message varies based on email delivery status and whether this is a resend
  const actionWord = isResend ? 'resent' : 'sent';
  const message =
    emailResult.status === 'sent'
      ? `Invitation ${actionWord} successfully`
      : emailResult.status === 'failed'
        ? `Invitation ${isResend ? 'regenerated' : 'created'} but email failed to send`
        : `Invitation ${isResend ? 'regenerated' : 'created'} (email service not configured)`;

  return { link, expiresAt, emailStatus: emailResult.status, message };
}
