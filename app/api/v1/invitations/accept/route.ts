/**
 * Accept an org invitation as an account that already exists (#1199, t-1006)
 *
 * POST /api/v1/invitations/accept — `{ token, email }` → the membership written
 *
 * The signed-in counterpart to `POST /api/auth/accept-invite`, which creates
 * an account and so cannot serve an address that already has one. An org's
 * admin can invite any address (`POST /api/v1/orgs/[id]/invitations`); when
 * the address has an account, its owner signs in and accepts here.
 *
 * The rules are `acceptInvitationAsExistingUser` in
 * `lib/tenancy/accept-invitation.ts`: the session must be signed in as the
 * invited address, verified; only an org invitation with no platform role is
 * accepted; and the membership follows the new-account path's rule, written
 * through `addMember`. A session for a different address is told so (403
 * `INVITATION_WRONG_ACCOUNT`) rather than redeeming it.
 *
 * A browser session only: an API key acts for its owner inside one org, and
 * joining another is not something its scopes cover. The token is the same
 * secret the public accept route takes, so the same per-IP cap applies.
 */

import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { ForbiddenError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { invitationLinkSchema } from '@/lib/validations/user';
import { acceptInvitationAsExistingUser } from '@/lib/tenancy/accept-invitation';
import { acceptInviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

export const POST = withAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);

    if (isApiKeySession(session)) {
      log.warn('Rejected API-key attempt to accept an invitation', { userId: session.user.id });
      throw new ForbiddenError('Accepting an invitation requires a browser session');
    }

    const clientIP = getClientIP(request);
    const rateLimitResult = acceptInviteLimiter.check(clientIP);
    if (!rateLimitResult.success) {
      log.warn('Accept invite rate limit exceeded', { ip: clientIP, userId: session.user.id });
      return createRateLimitResponse(rateLimitResult);
    }

    const { token, email } = await validateRequestBody(request, invitationLinkSchema);

    const membership = await acceptInvitationAsExistingUser(
      {
        id: session.user.id,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        role: session.user.role,
      },
      email,
      token
    );

    return successResponse({
      message: 'Invitation accepted',
      membership: { orgId: membership.orgId, role: membership.role },
    });
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        'Writes a membership for `session.user.id` only, and only when the invitation names the session’s own verified address; no other subject can be named.',
    },
  }
);
