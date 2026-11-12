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
 *   - email: User's email address (required). An address that already has an
 *     account may be invited into an org other than the install org at the
 *     default role, as the org route allows (#1199, t-1008); any other
 *     invitation to it is a 409 EMAIL_TAKEN
 *   - role: User's role (optional, defaults to USER)
 *   - orgId: The org the invitee joins on acceptance (optional; defaults to
 *     the install org) — must exist and be ACTIVE (§106)
 *   - orgRole: Their role in that org (optional; MEMBER, or OWNER for the
 *     org's first non-staff member). Refused for the install org, whose role
 *     follows the platform `role` (#871). An OWNER invitation is accepted as
 *     MEMBER if its issuer no longer holds owner standing then (#1235)
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
 * 5. Find the pending invitation in the target org
 * 6. Resolve that org (§106): the body's, else on a resend the pending
 *    invitation's
 * 6a. Check the org: it must exist and be active, and the policy must let
 *    this caller administer it (`canAdminister` on an org resource — the
 *    seam §106 t-671 makes org-aware; today it answers as the admin guard
 *    did). Asked before anything answers about the address's membership of
 *    that org
 * 6b. If the address already has an account: a platform invitation (a
 *    platform role, or the install org) is a 409 EMAIL_TAKEN; someone
 *    already in the target org is a 409 ALREADY_MEMBER; an org invitation
 *    goes on, and its email asks them to sign in (t-1008)
 * 6c. Check if invitation already exists:
 *    - If exists and resend=false: Return 200 with 'pending' status (NO link)
 *    - Else an OWNER org invitation, or a resend of one, needs a platform
 *      admin (owner standing in the body's org cannot be read here)
 *    - If exists and resend=true: Delete old, create new token, send email
 *    - If not exists: Create new invitation
 * 7. Generate/regenerate invitation token
 * 8. Send invitation email
 * 9. Return invitation details (NOT user object)
 *
 * Note: User is NOT created until invitation is accepted (Option B pattern)
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { canAdminister } from '@/lib/auth/authorization';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { ErrorCodes, ForbiddenError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { inviteUserSchema } from '@/lib/validations/user';
import {
  invitationOrgSlot,
  isPlatformInvitation,
  pendingInvitationsFor,
} from '@/lib/utils/invitation-token';
import { deliverInvitation } from '@/lib/auth/invitation-delivery';
import { getRouteLogger } from '@/lib/api/context';
import { inviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { DEFAULT_USER_ROLE, isPlatformAdmin } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

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
 * @throws ConflictError if the address has an account and this is a platform invitation
 */
export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  log.info('Processing user invitation request');

  // 1. Check invite rate limit (prevents email bombing)
  const clientIP = getClientIP(request);
  const rateLimitResult = inviteLimiter.check(clientIP);

  if (!rateLimitResult.success) {
    log.warn('Invite rate limit exceeded', {
      ip: clientIP,
      adminId: session.user.id,
      remaining: rateLimitResult.remaining,
      reset: rateLimitResult.reset,
    });
    return createRateLimitResponse(rateLimitResult);
  }

  // 3. Validate request body
  const body = await validateRequestBody(request, inviteUserSchema);

  // An install-org role follows the platform role, as on the members screen,
  // which refuses to edit it (#871). So an `orgRole` with no other org named
  // is refused rather than stored: `role` is what sets it.
  if (body.orgRole !== undefined && (!body.orgId || body.orgId === INSTALL_ORG_ID)) {
    return errorResponse(
      'A role in the main organisation follows the platform role; set role instead',
      { code: ErrorCodes.VALIDATION_ERROR, status: 400 }
    );
  }

  // The platform role is platform standing, whatever org this invitation
  // targets: on acceptance it becomes `User.role`, and the install-org role
  // follows from it. So only a platform admin may set anything above the
  // default. Under Sunrise's default policy only platform admins pass the
  // guard, so this changes nothing; it is the floor for a fork whose
  // `canAdminister` admits an org's OWNER/ADMIN, which may narrow but never
  // widen the platform-only surface (t-833). Read from the principal, so a
  // support session — which presents the default role — is refused too.
  if (body.role !== DEFAULT_USER_ROLE && !isPlatformAdmin(session.principal)) {
    log.warn('Invitation with a platform role refused: caller is not a platform admin', {
      adminId: session.user.id,
      role: body.role,
    });
    throw new ForbiddenError('Only a platform administrator can set a platform role');
  }

  // 4. Parse resend query parameter
  const url = new URL(request.url);
  const resend = url.searchParams.get('resend') === 'true';

  // 5. The pending invitation this request is about. An address holds one
  // per org (#1199), so it is the one in the org the body names, never just
  // the newest: that could be another org's, and re-sending it would replace
  // that org's invitation. A body naming no org means the install org's: the
  // admin table's Resend names the row's org, so an org invitation is never
  // reached by naming none.
  const pending = await pendingInvitationsFor(body.email);
  const targetSlot = invitationOrgSlot(body.orgId);
  const existingInvitation =
    pending.readable.find((inv) => invitationOrgSlot(inv.metadata.orgId) === targetSlot) ?? null;

  // 6. Which org this invitation joins, and as what (§106). The body's org
  // keys when it sends either of them; else, on a resend, the pending row's —
  // a resend re-sends THIS invitation, so its org role carries over. The
  // platform `role` has always come from the body on a resend; that is
  // unchanged.
  const bodyNamesTarget = body.orgId !== undefined || body.orgRole !== undefined;
  const named = bodyNamesTarget
    ? { orgId: body.orgId, orgRole: body.orgRole }
    : {
        orgId: existingInvitation?.metadata.orgId,
        orgRole: existingInvitation?.metadata.orgRole,
      };

  // A resend can carry an install-org `orgRole` from an invitation written
  // before the body check above refused one; drop it, so the role follows the
  // platform role (#871).
  const intoInstall = !named.orgId || named.orgId === INSTALL_ORG_ID;
  const target = intoInstall ? { orgId: named.orgId, orgRole: undefined } : named;
  const writesPlatform = isPlatformInvitation({
    role: body.role || DEFAULT_USER_ROLE,
    orgId: target.orgId,
  });

  // 6a. The org is in the body (or the pending row), so this cannot be a
  // `resource` resolver on the guard (a resolver runs before the body is
  // read); the same question is asked here instead, of the same policy.
  // Under Sunrise's default policy `canAdminister` answers for an org
  // resource exactly as it did for the guard's `null` — platform admins (and
  // admin-scoped keys) only — so nothing widens today; t-671 is what teaches
  // it to say yes to an org's own OWNER/ADMIN. Asked on a resend too: the
  // pending org must still exist, be active, and be one this caller may
  // invite into. Asked before anything below answers about the address's
  // membership of that org, so a caller refused for it learns nothing of it.
  // (An install-org invitation asks no org question, and its EMAIL_TAKEN
  // answer is the guard's to gate, as it always was.)
  // The org the email names (#1199): an invitation into an org reads "join
  // <org>" from either route that writes it. The install org's names the app.
  let orgName: string | undefined;
  if (target.orgId) {
    const org = await prisma.org.findUnique({
      where: { id: target.orgId },
      select: { id: true, status: true, name: true },
    });

    if (!org || org.status !== 'ACTIVE') {
      // One answer for "no such org" and "suspended": an inviter who may
      // administer the org can see its status elsewhere; nobody else should
      // learn it from this endpoint.
      return errorResponse('Cannot invite into that organisation', {
        code: ErrorCodes.VALIDATION_ERROR,
        status: 400,
      });
    }

    if (!intoInstall) orgName = org.name;

    const mayInvite = await canAdminister(session.principal, {
      kind: 'org',
      id: org.id,
      orgId: org.id,
    });
    if (!mayInvite) {
      log.warn('Invitation into org refused by the authorization policy', {
        adminId: session.user.id,
        orgId: org.id,
      });
      throw new ForbiddenError('You cannot invite users into that organisation');
    }
  }

  // 6b. An address that already has an account (#1199, t-1008). A platform
  // invitation (a platform role, or the install org) creates the account, so
  // an existing one cannot redeem it: refused, as it always was. An
  // invitation into another org at the default role is what the org route
  // sends to an existing account, and it is sent here the same way: the email
  // asks them to sign in and accept, and the answer below does not depend on
  // whether the account exists. Someone already in that org is refused as the
  // org route refuses them, once the caller is known to administer it (6a).
  const existingUser = await prisma.user.findUnique({
    where: { email: body.email },
    select: {
      id: true,
      orgMemberships: target.orgId
        ? { where: { orgId: target.orgId }, select: { id: true } }
        : { take: 0, select: { id: true } },
    },
  });

  if (existingUser && writesPlatform) {
    return errorResponse('User already exists with this email', {
      code: ErrorCodes.EMAIL_TAKEN,
      status: 409,
    });
  }
  if (existingUser && existingUser.orgMemberships.length > 0) {
    throw new OrgLifecycleError('ALREADY_MEMBER', 'That person is already a member');
  }

  // 6c. An invitation already pending in this org.
  if (existingInvitation && !resend) {
    // Return existing invitation details WITHOUT a link (can't generate valid one)
    // Admin must use ?resend=true to send a new email with valid link
    log.info('Existing invitation found, not resending', {
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
          // Where the pending invitation points (§106); a resend keeps it
          // unless the body names an org.
          orgId: existingInvitation.metadata.orgId ?? null,
          orgRole: existingInvitation.metadata.orgRole ?? null,
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

  // Inviting someone as an OWNER, or replacing a pending OWNER invitation,
  // needs owner standing, as on the org route: accepting one writes the
  // membership on the strength of the check made here (t-1008). The org
  // route reads standing in the org its URL names; here the org is the
  // body's, and the caller's org role is for the org their session entered,
  // so only a platform admin has it. Read from the principal, so a support
  // session is refused, as by the platform-role floor above.
  if (
    !intoInstall &&
    (target.orgRole === ORG_OWNER_ROLE ||
      existingInvitation?.metadata.orgRole === ORG_OWNER_ROLE) &&
    !isPlatformAdmin(session.principal)
  ) {
    log.warn('OWNER org invitation refused: caller is not a platform admin', {
      adminId: session.user.id,
      orgId: target.orgId,
    });
    throw new OrgLifecycleError('OWNER_STANDING', 'Only an owner may invite someone as an owner');
  }

  // The same floor for a pending platform-role invitation: re-sending one
  // rewrites its role and org, and writing another beside it would leave it
  // unredeemable once the address has an account, so either is a platform
  // admin's to do (t-833), as the org invitations route refuses it outright.
  // Any of the address's pending invitations counts, not just the one this
  // request re-sends (#1199).
  const pendingPlatformRole = pending.readable.find(
    (inv) => inv.metadata.role !== DEFAULT_USER_ROLE
  );
  if (pendingPlatformRole && !isPlatformAdmin(session.principal)) {
    log.warn('Resend of a platform-role invitation refused: caller is not a platform admin', {
      adminId: session.user.id,
      pendingRole: pendingPlatformRole.metadata.role,
    });
    throw new ForbiddenError(
      'Only a platform administrator can invite this address while an invitation granting a platform role is pending for it'
    );
  }

  // A platform invitation (a platform role, or the install org) and an org
  // invitation are not written side by side for one address (#1199).
  // Whichever is accepted first creates the account, and an existing account
  // cannot redeem a platform invitation, so it would be stranded. Checked in
  // both directions, for a new invitation and for a resend that changes the
  // pending one's kind. A resend of the same kind writes no new pair. The org
  // route refuses the same way.
  const keepsKind =
    existingInvitation !== null &&
    isPlatformInvitation(existingInvitation.metadata) === writesPlatform;
  const others = pending.readable.filter((inv) => inv !== existingInvitation);
  // An org invitation, new or re-sent, is refused beside a row it cannot
  // read too, which could be a platform one, as the org route refuses it.
  if (
    (!writesPlatform && pending.unreadable > 0) ||
    (!keepsKind && others.some((inv) => isPlatformInvitation(inv.metadata) !== writesPlatform))
  ) {
    log.info('Invitation refused: it would sit beside the other kind of pending invitation', {
      adminId: session.user.id,
      writesPlatform,
    });
    return errorResponse(
      writesPlatform
        ? 'An invitation into an organisation is already pending for this email address. Delete it from the pending invitations first.'
        : 'An invitation to the platform is already pending for this email address. Delete it from the pending invitations first.',
      { code: ErrorCodes.CONFLICT, status: 409 }
    );
  }

  // 7. Generate or regenerate invitation token
  const invitationMetadata = {
    name: body.name,
    role: body.role || DEFAULT_USER_ROLE,
    invitedBy: session.user.id,
    invitedAt: new Date().toISOString(),
    // Only written when named, so an invitation into the install org is
    // byte-identical to one written before these keys existed.
    ...(target.orgId ? { orgId: target.orgId } : {}),
    ...(target.orgRole ? { orgRole: target.orgRole } : {}),
  };

  // 7–8. Store the token (replacing the pending one on a resend) and send the email
  const delivered = await deliverInvitation({
    email: body.email,
    name: body.name,
    metadata: invitationMetadata,
    // Replaces the pending invitation in the target org only; the address's
    // invitations into other orgs stay (#1199).
    isResend: !!existingInvitation,
    inviterName: session.user.name || 'Administrator',
    ...(orgName !== undefined ? { orgName } : {}),
    // Only an org invitation reaches here with an account (6b). The answer
    // below is the same either way; only the email differs.
    hasAccount: !!existingUser,
    log,
  });

  log.info(existingInvitation ? 'Invitation resent' : 'Invitation created', {
    email: body.email,
    role: body.role,
    orgId: target.orgId ?? null,
    orgRole: target.orgRole ?? null,
    invitedBy: session.user.id,
    isResend: !!existingInvitation,
  });

  // 9. Return invitation details (NOT user object)
  return successResponse(
    {
      message: delivered.message,
      invitation: {
        email: body.email,
        name: body.name,
        role: body.role || DEFAULT_USER_ROLE,
        orgId: target.orgId ?? null,
        orgRole: target.orgRole ?? null,
        // The value stored on the invitation, which the user-created seam
        // reports when it is redeemed (#1136); a second clock read differed.
        invitedAt: invitationMetadata.invitedAt,
        expiresAt: delivered.expiresAt.toISOString(),
        link: delivered.link,
      },
      emailStatus: delivered.emailStatus,
    },
    undefined,
    { status: 201 }
  );
});
