/**
 * Invite someone into an org, for the people who administer it (§111 t-813)
 *
 * POST /api/v1/orgs/[id]/invitations — `{ name, email, orgRole? }`. The
 * invitee joins this org on acceptance, as a platform USER.
 * POST /api/v1/orgs/[id]/invitations?resend=true — re-send this org's pending
 * invitation to that email, with a new token.
 *
 * The org's own counterpart to `POST /api/v1/users/invite`, which stays the
 * platform's: that one sets a platform role and can name any org, so it is
 * not something an org admin may call. This one cannot do either. Admission
 * is the policy's, through the same org `resource` the members routes hand
 * the guard (see `members/route.ts` for who the org arm admits); the rules
 * on what may be invited are `checkInvitationInto` in
 * `lib/tenancy/lifecycle.ts`. Nothing here decides who may call it.
 *
 * What this route will not do to an invitation it does not own: a pending
 * invitation for the same email into another org, or one carrying a platform
 * role, is answered with a 409 that names neither, and is left as it was.
 * Re-sending it from here would re-target someone else's invitation to this
 * org. An email that already has an account gets a 409 too: an org admin
 * cannot add an existing account, because the roster's add-by-id takes a user
 * id they have no way to look up. That leaves the answer saying an account
 * exists, which an org admin could not otherwise learn. The cost is accepted
 * because the invitation cannot be sent either way, and the inviter needs to
 * know why.
 *
 * **The invitation link is never returned.** The platform route returns it so
 * a platform admin can hand it over when email is down. Here the inviter is a
 * tenant's admin, and the token is all `accept-invite` asks for before it
 * creates a verified account with a password the caller picks. So the link
 * reaches the invitee by email only. If email is not configured, the
 * invitation is stored, and a platform admin re-sends it from Users.
 *
 * A browser session only, as the members routes require: the roster's shape
 * is not something a key's scopes cover.
 */

import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { DEFAULT_USER_ROLE } from '@/lib/auth/roles';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { ErrorCodes, ForbiddenError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { orgIdParamSchema, inviteOrgMemberSchema } from '@/lib/validations/tenancy';
import {
  checkInvitationInto,
  resolveOrgResource,
  membershipActorOf,
} from '@/lib/tenancy/lifecycle';
import { getValidInvitation, INVITATION_IDENTIFIER_PREFIX } from '@/lib/utils/invitation-token';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { deliverInvitation } from '@/lib/auth/invitation-delivery';
import { inviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getRouteLogger } from '@/lib/api/context';

const RESOURCE = {
  resource: async (_request: unknown, context?: { params: Promise<{ id: string }> }) =>
    resolveOrgResource(await context?.params),
  // Ownership: the policy decided about the org the resolver named, and the
  // invitation written is keyed on that resolved id.
  ownership: {
    decidedBy: 'resource',
    because:
      'The policy admitted the caller to the org the URL names; the invitation is written for that resolved org id, and a pending invitation into any other org is refused rather than touched.',
  },
} as const;

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  if (isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to invite an org member', { userId: session.user.id });
    throw new ForbiddenError('Inviting members requires a browser session');
  }

  // Prevents email bombing, as on the platform's invite route.
  const clientIP = getClientIP(request);
  const rateLimitResult = inviteLimiter.check(clientIP);
  if (!rateLimitResult.success) {
    log.warn('Invite rate limit exceeded', { ip: clientIP, userId: session.user.id });
    return createRateLimitResponse(rateLimitResult);
  }

  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const body = await validateRequestBody(request, inviteOrgMemberSchema);
  const resend = new URL(request.url).searchParams.get('resend') === 'true';

  const actor = membershipActorOf(session);
  await checkInvitationInto(id, body.orgRole, actor);

  const existingUser = await prisma.user.findUnique({
    where: { email: body.email },
    select: { id: true },
  });
  if (existingUser) {
    return errorResponse(
      'This person already has an account. Ask a platform admin to add them to the organisation.',
      { code: ErrorCodes.EMAIL_TAKEN, status: 409 }
    );
  }

  // `getValidInvitation` answers null for a row it cannot parse, and for a
  // failed read, which here would mean "nothing pending" and let a new token
  // replace another org's invitation. So when it says null, look for any
  // unexpired row before believing it: a row this route cannot read is one
  // it does not own.
  const existingInvitation = await getValidInvitation(body.email);
  const unreadablePending =
    !existingInvitation &&
    (await prisma.verification.count({
      where: {
        identifier: `${INVITATION_IDENTIFIER_PREFIX}${body.email}`,
        expiresAt: { gt: new Date() },
      },
    })) > 0;
  if (
    unreadablePending ||
    (existingInvitation &&
      (existingInvitation.metadata.orgId !== id ||
        existingInvitation.metadata.role !== DEFAULT_USER_ROLE))
  ) {
    log.info('Invitation refused: another invitation is pending for this email', {
      orgId: id,
      userId: session.user.id,
    });
    return errorResponse('An invitation is already pending for this email address.', {
      code: ErrorCodes.CONFLICT,
      status: 409,
    });
  }

  if (existingInvitation && !resend) {
    return successResponse({
      message: 'Invitation already pending. Use ?resend=true to send a new invitation email.',
      invitation: {
        email: body.email,
        name: existingInvitation.metadata.name,
        orgId: id,
        orgRole: existingInvitation.metadata.orgRole ?? null,
        invitedAt: existingInvitation.metadata.invitedAt,
        expiresAt: existingInvitation.expiresAt.toISOString(),
      },
      emailStatus: 'pending' as const,
    });
  }

  // A resend re-issues the pending invitation, so it keeps the pending role
  // unless the body names one (as the platform route keeps the pending org).
  // And it is a change to that invitation: replacing an OWNER invitation
  // needs owner standing whatever the new role is, as changing an OWNER's
  // role does on the members routes.
  const orgRole = body.orgRole ?? existingInvitation?.metadata.orgRole;
  if (existingInvitation?.metadata.orgRole === ORG_OWNER_ROLE) {
    await checkInvitationInto(id, ORG_OWNER_ROLE, actor);
  }

  const invitedAt = new Date().toISOString();
  const delivered = await deliverInvitation({
    email: body.email,
    name: body.name,
    metadata: {
      name: body.name,
      role: DEFAULT_USER_ROLE,
      invitedBy: session.user.id,
      invitedAt,
      orgId: id,
      ...(orgRole ? { orgRole } : {}),
    },
    isResend: !!existingInvitation,
    inviterName: session.user.name || 'Administrator',
    log,
  });

  log.info(existingInvitation ? 'Org invitation resent' : 'Org invitation created', {
    orgId: id,
    email: body.email,
    orgRole: orgRole ?? null,
    invitedBy: session.user.id,
  });

  return successResponse(
    {
      message: delivered.message,
      invitation: {
        email: body.email,
        name: body.name,
        orgId: id,
        orgRole: orgRole ?? null,
        invitedAt,
        expiresAt: delivered.expiresAt.toISOString(),
        // No `link`: the token in it is the only proof acceptance asks for,
        // and acceptance verifies the email. Handing it to the inviter would
        // let an org admin open a verified account for an address they do
        // not own, so it goes to the invitee by email and nowhere else.
      },
      emailStatus: delivered.emailStatus,
    },
    undefined,
    { status: 201 }
  );
}, RESOURCE);
