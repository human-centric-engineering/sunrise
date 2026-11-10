/**
 * Admin Single Invitation Endpoint
 *
 * DELETE /api/v1/admin/invitations/:email - Delete a pending invitation
 * DELETE /api/v1/admin/invitations/:email?orgId=<id|install> - Delete only that
 *   org's invitation for the address (#1199). An address can hold one pending
 *   invitation per org; the admin table names the row it shows, so revoking
 *   one does not take the address's other orgs' with it. Without `orgId`,
 *   every invitation for the address goes, as before.
 *
 * Authentication: Required (Admin role only)
 */

import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validatePathParam } from '@/lib/api/validation';
import { emailSchema } from '@/lib/validations/auth';
import { withAdminAuth } from '@/lib/auth/guards';
import {
  deleteInvitationToken,
  deleteInvitationsInOrg,
  pendingInvitationsFor,
} from '@/lib/utils/invitation-token';
import { z } from 'zod';
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
 * @throws ValidationError if the path segment is not a well-formed email address
 * @throws NotFoundError if invitation not found
 */
export const DELETE = withAdminAuth<{ email: string }>(async (request, session, { params }) => {
  // The path segment is an email address. The endpoint heuristic collapses it
  // too, but pin the pattern so the route says so itself and logs a readable
  // `endpoint` rather than `[param]` (#685).
  const log = await getRouteLogger(request, { endpoint: '/api/v1/admin/invitations/[email]' });

  // Get email from URL params
  const { email } = await params;

  // Next has already decoded the segment once; this second decode keeps a
  // client that double-encodes working. A stray `%` makes it throw, and that
  // is a bad address, not a server fault (#954).
  let decoded: string;
  try {
    decoded = decodeURIComponent(email);
  } catch {
    throw new ValidationError('Invalid email address', {
      email: ['The address contains a malformed percent-escape'],
    });
  }
  // The schema every invitation is created through, so the trimmed, lowercased
  // address matches the one stored.
  const decodedEmail = validatePathParam(decoded, emailSchema, {
    label: 'email address',
    field: 'email',
  });

  log.info('Deleting invitation', { email: decodedEmail });

  // One org's invitation, when the caller names it ('install' for the install
  // org); the address's others are left.
  const orgParam = request.nextUrl.searchParams.get('orgId');
  if (orgParam !== null) {
    const orgId = z.string().min(1).max(64).safeParse(orgParam);
    if (!orgId.success) {
      throw new ValidationError('Invalid organisation id', { orgId: ['Must be an org id'] });
    }
    const count = await deleteInvitationsInOrg(decodedEmail, orgId.data);
    // Expired rows go too: revoking one is a cleanup, not a refusal.
    if (count === 0) throw new NotFoundError('Invitation not found');
    log.info('Admin deleted one org invitation', {
      email: decodedEmail,
      orgId: orgId.data,
      deletedBy: session.user.id,
    });
    return successResponse({ message: `Invitation for ${decodedEmail} has been deleted` });
  }

  // Check if invitation exists
  // Any unexpired invitation for the address, in any org (#1199): the newest
  // row alone is no test once an address holds one per org.
  const pending = await pendingInvitationsFor(decodedEmail);
  if (pending.readable.length === 0 && pending.unreadable === 0) {
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
