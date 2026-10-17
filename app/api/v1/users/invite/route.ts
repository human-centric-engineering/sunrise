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
 *   - orgId: The org the invitee joins on acceptance (optional; defaults to
 *     the install org) — must exist and be ACTIVE (§106)
 *   - orgRole: Their role in that org (optional; MEMBER, or OWNER for the
 *     first member of a new org). Refused for the install org, whose role
 *     follows the platform `role` (#871)
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
 * 6b. Resolve the org (§106): the body's, else on a resend the pending
 *     invitation's; it must exist and be active, and the policy must let this
 *     caller administer it (`canAdminister` on an org resource — the seam
 *     §106 t-671 makes org-aware; today it answers as the admin guard did)
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
import { getValidInvitation } from '@/lib/utils/invitation-token';
import { deliverInvitation } from '@/lib/auth/invitation-delivery';
import { getRouteLogger } from '@/lib/api/context';
import { inviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { DEFAULT_USER_ROLE, isPlatformAdmin } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

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

  // The same floor for the invitation a resend replaces: re-sending a pending
  // platform-role invitation rewrites its role and org, so it is a platform
  // admin's to do (t-833), as the org invitations route refuses it outright.
  if (
    existingInvitation &&
    existingInvitation.metadata.role !== DEFAULT_USER_ROLE &&
    !isPlatformAdmin(session.principal)
  ) {
    log.warn('Resend of a platform-role invitation refused: caller is not a platform admin', {
      adminId: session.user.id,
      pendingRole: existingInvitation.metadata.role,
    });
    throw new ForbiddenError(
      'Only a platform administrator can re-send an invitation that grants a platform role'
    );
  }

  // 6b. Which org this invitation joins, and as what (§106). The body's org
  // keys when it sends either of them; else, on a resend, the pending row's —
  // a resend re-sends THIS invitation, and the
  // admin table's Resend button posts only `{ name, email, role }`, so
  // without the carry-over a bounced invitation into an org would be
  // silently re-targeted to the install org. The platform `role` has always
  // come from the body on a resend; that is unchanged.
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

  // The org is in the body (or the pending row), so this cannot be a
  // `resource` resolver on the guard (a resolver runs before the body is
  // read); the same question is asked here instead, of the same policy.
  // Under Sunrise's default policy `canAdminister` answers for an org
  // resource exactly as it did for the guard's `null` — platform admins (and
  // admin-scoped keys) only — so nothing widens today; t-671 is what teaches
  // it to say yes to an org's own OWNER/ADMIN. Asked on a resend too: the
  // pending org must still exist, be active, and be one this caller may
  // invite into.
  if (target.orgId) {
    const org = await prisma.org.findUnique({
      where: { id: target.orgId },
      select: { id: true, status: true },
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
    isResend: !!existingInvitation,
    inviterName: session.user.name || 'Administrator',
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
        invitedAt: new Date().toISOString(),
        expiresAt: delivered.expiresAt.toISOString(),
        link: delivered.link,
      },
      emailStatus: delivered.emailStatus,
    },
    undefined,
    { status: 201 }
  );
});
