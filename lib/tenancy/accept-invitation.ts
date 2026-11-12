/**
 * Accept or decline an org invitation as an account that already exists
 * (#1199, t-1006).
 *
 * A new account redeems its invitation by being created: the password and
 * OAuth accept-invite paths hand the invitation to the user-creation hooks,
 * and `membershipForNewUser` decides the membership. An address that already
 * has an account cannot go that way, so it signs in and accepts here. The
 * membership is decided by the same rule (the invitation's org and role,
 * and the per-org first-owner bootstrap), then written
 * through `addMember`, the lifecycle's one writer of a membership for an
 * existing user.
 *
 * What acceptance requires, beyond the token: a session signed in as the
 * invited address, with that address verified. The token proves the email
 * arrived; the session proves who is acting on it. A session signed in as
 * anyone else is refused, and told so, rather than redeeming the invitation
 * into the wrong account.
 *
 * Only an org invitation with no platform role can be accepted here. One that
 * grants a platform role, or names no org, is the platform's invitation from
 * Users. It is written to create an account, and an existing account is not
 * given a platform role by following a link.
 */

import { APIError, ErrorCodes, NotFoundError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';
import { addMember, type MembershipActor, type MembershipRecord } from '@/lib/tenancy/lifecycle';
import { membershipForNewUser } from '@/lib/tenancy/membership';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import {
  consumeInvitation,
  deleteInvitationByToken,
  findInvitationByToken,
  getInvitationMetadata,
  isPlatformInvitation,
} from '@/lib/utils/invitation-token';

/** Error codes this module answers with, beyond the shared ones. */
export const INVITATION_ERROR_CODES = {
  /** Signed in as an account whose address is not the invited one. */
  WRONG_ACCOUNT: 'INVITATION_WRONG_ACCOUNT',
  /** Signed in as the invited address, but it is not verified. */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  /** A platform invitation, which only creates an account. */
  NEEDS_NEW_ACCOUNT: 'INVITATION_NEEDS_NEW_ACCOUNT',
} as const;

/** The signed-in account accepting, as far as acceptance reads it. */
export interface InvitationAccepter {
  id: string;
  email: string;
  emailVerified: boolean;
  role?: string | null;
}

/**
 * The standing an accepted invitation carries into `addMember`.
 *
 * An explicit `OWNER` invitation was allowed only to an inviter with owner
 * standing, checked when it was issued (`checkInvitationInto`).
 * `membershipForNewUser` asks the issuer's standing again, now, from
 * `invitedBy`, before deciding the role: for the first-owner bootstrap, and
 * for an explicit `OWNER`, which narrows to `MEMBER` once that standing has
 * lapsed (#1235). So acceptance writes only a role those checks admitted at
 * acceptance; the invitee's own standing has nothing to do with it.
 */
const ISSUED_INVITATION_ACTOR: MembershipActor = {
  platformAdmin: false,
  orgRole: ORG_OWNER_ROLE,
};

/** Addresses are stored lowercased; a session's may not be. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Accept the invitation `token` redeems, as `accepter`, and answer the
 * membership it wrote.
 *
 * Refuses, with a code a client can branch on: a session for a different
 * address (403 `INVITATION_WRONG_ACCOUNT`); an unverified address (403
 * `EMAIL_NOT_VERIFIED`); an expired invitation (410 `INVITATION_EXPIRED`); a
 * missing or already-used one (404); a platform invitation (409
 * `INVITATION_NEEDS_NEW_ACCOUNT`); and someone already a member (409
 * `ALREADY_MEMBER`, which also deletes the invitation it made moot).
 *
 * The membership is written before the invitation is deleted, so a failure
 * in between leaves the invitation to retry rather than losing it. A second
 * acceptance after that point is refused as `ALREADY_MEMBER`.
 */
export async function acceptInvitationAsExistingUser(
  accepter: InvitationAccepter,
  invitedEmail: string,
  token: string
): Promise<MembershipRecord> {
  if (!sameAddress(accepter.email, invitedEmail)) {
    logger.warn('Invitation acceptance refused: signed in as a different account', {
      userId: accepter.id,
    });
    throw new APIError(
      'This invitation was sent to a different email address. Sign out, then sign in with the address it was sent to.',
      INVITATION_ERROR_CODES.WRONG_ACCOUNT,
      403
    );
  }
  if (!accepter.emailVerified) {
    throw new APIError(
      'Verify your email address before accepting this invitation.',
      INVITATION_ERROR_CODES.EMAIL_NOT_VERIFIED,
      403
    );
  }

  const invitation = await findInvitationByToken(invitedEmail, token);
  if (!invitation) {
    const lookup = await getInvitationMetadata(invitedEmail, token);
    if (!lookup.valid && lookup.reason === 'expired') {
      throw new APIError('This invitation has expired', ErrorCodes.INVITATION_EXPIRED, 410);
    }
    throw new NotFoundError('Invitation not found');
  }

  const metadata = invitation.metadata;
  if (!metadata) throw new NotFoundError('Invitation not found');

  const orgId = metadata.orgId;
  if (isPlatformInvitation(metadata) || orgId === undefined) {
    logger.warn('Invitation acceptance refused: a platform invitation needs a new account', {
      userId: accepter.id,
    });
    throw new APIError(
      'This invitation can only be used to create a new account. Ask the person who invited you to send a new invitation from your organisation.',
      INVITATION_ERROR_CODES.NEEDS_NEW_ACCOUNT,
      409
    );
  }

  // The new-account rule, so the two paths cannot disagree: the invitation's
  // org role, default MEMBER, and OWNER by the first-owner bootstrap.
  // `accepter.role` is the account's own platform role: a platform ADMIN
  // accepting here is staff, and does not take that bootstrap (#1178).
  const { role } = await membershipForNewUser({ role: accepter.role }, metadata);

  let membership: MembershipRecord;
  try {
    membership = await addMember(orgId, accepter.id, role, ISSUED_INVITATION_ACTOR);
  } catch (error) {
    // Already a member: the invitation has nothing left to grant.
    if (error instanceof APIError && error.code === 'ALREADY_MEMBER') {
      await consumeInvitation(invitation.id);
    }
    throw error;
  }

  await consumeInvitation(invitation.id);
  logger.info('Invitation accepted by an existing account', {
    userId: accepter.id,
    orgId,
    role: membership.role,
  });
  return membership;
}

/**
 * Decline the invitation `token` redeems: delete it, and only it. The token
 * is the whole authority, as it is for accepting into a new account: whoever
 * holds the emailed link may turn it down without an account. Every other
 * invitation for the address is left. 404 when there is nothing to delete.
 */
export async function declineInvitation(invitedEmail: string, token: string): Promise<void> {
  const deleted = await deleteInvitationByToken(invitedEmail, token);
  if (!deleted) throw new NotFoundError('Invitation not found');
}
