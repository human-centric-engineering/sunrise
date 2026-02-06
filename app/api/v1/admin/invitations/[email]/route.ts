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
import { getRouteLogger } from '@/lib/api/context';

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
export const DELETE = withAdminAuth<{ email: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  // Get email from URL params
  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);

  log.info('Deleting invitation', { email: decodedEmail });

  // Check if invitation exists
  const invitation = await getValidInvitation(decodedEmail);
  if (!invitation) {
    throw new NotFoundError('Invitation not found or already expired');
  }

  // Delete the invitation
  await deleteInvitationToken(decodedEmail);

  log.info('Admin deleted invitation', {
    email: decodedEmail,
    deletedBy: session.user.id,
    deletedByEmail: session.user.email,
  });

  return successResponse({
    message: `Invitation for ${decodedEmail} has been deleted`,
  });
});
