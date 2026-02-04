/**
 * Admin Single Invitation Endpoint
 *
 * DELETE /api/v1/admin/invitations/:email - Delete a pending invitation
 *
 * Authentication: Required (Admin role only)
 */

import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { deleteInvitationToken, getValidInvitation } from '@/lib/utils/invitation-token';
import { logger } from '@/lib/logging';

/**
 * DELETE /api/v1/admin/invitations/:email
 *
 * Deletes a pending user invitation by email address.
 *
 * @example
 * DELETE /api/v1/admin/invitations/user@example.com
 *
 * @returns Success message
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws NotFoundError if invitation not found
 */
export const DELETE = withAdminAuth<{ email: string }>(async (_request, session, { params }) => {
  // Get email from URL params
  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);

  // Check if invitation exists
  const invitation = await getValidInvitation(decodedEmail);
  if (!invitation) {
    throw new NotFoundError('Invitation not found or already expired');
  }

  // Delete the invitation
  await deleteInvitationToken(decodedEmail);

  logger.info('Admin deleted invitation', {
    email: decodedEmail,
    deletedBy: session.user.id,
    deletedByEmail: session.user.email,
  });

  return successResponse({
    message: `Invitation for ${decodedEmail} has been deleted`,
  });
});
