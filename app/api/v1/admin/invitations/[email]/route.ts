/**
 * Admin Single Invitation Endpoint
 *
 * DELETE /api/v1/admin/invitations/:email - Delete a pending invitation
 *
 * Authentication: Required (Admin role only)
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { successResponse } from '@/lib/api/responses';
import { UnauthorizedError, ForbiddenError, NotFoundError, handleAPIError } from '@/lib/api/errors';
import { deleteInvitationToken, getValidInvitation } from '@/lib/utils/invitation-token';
import { logger } from '@/lib/logging';

interface RouteParams {
  params: Promise<{ email: string }>;
}

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
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    // Authenticate and check role
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    if (session.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }

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
  } catch (error) {
    return handleAPIError(error);
  }
}
