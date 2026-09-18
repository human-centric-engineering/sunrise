/**
 * One membership, for the people who administer the org (§106 t-672)
 *
 * PATCH  /api/v1/orgs/[id]/members/[userId] — change the role: `{ role }`.
 * DELETE /api/v1/orgs/[id]/members/[userId] — remove the member; their
 *        sessions acting in this org are revoked with the row.
 *
 * Admission is the policy's, through the same `resource` the sibling
 * members route hands the guard (see its header for who the org arm
 * admits). The rules are `lib/tenancy/lifecycle.ts`'s: the install org's
 * memberships are refused (roles follow the platform role; a user leaves
 * the install org by being erased), and the org's last OWNER can be neither
 * demoted nor removed. An OWNER may remove themselves only while another
 * OWNER stands — the same guard, applied to the caller.
 */

import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { orgMemberParamsSchema, updateOrgMemberSchema } from '@/lib/validations/tenancy';
import { changeMemberRole, removeMember, resolveOrgResource } from '@/lib/tenancy/lifecycle';
import { getRouteLogger } from '@/lib/api/context';

type Params = { id: string; userId: string };

const RESOURCE = {
  resource: async (_request: unknown, context?: { params: Promise<Params> }) =>
    resolveOrgResource(await context?.params),
  // Ownership: the policy decided about the org the resolver named, and the
  // handlers write nothing outside it — see RouteOwnership in lib/auth/guards.ts.
  ownership: {
    decidedBy: 'resource',
    because:
      'The policy admitted the caller to the org the URL names; the membership written is keyed on that resolved org id and the URL’s user id.',
  },
} as const;

export const PATCH = withAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  if (isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to change an org member’s role', {
      userId: session.user.id,
    });
    throw new ForbiddenError('Managing members requires a browser session');
  }

  const { id, userId } = validateQueryParams(
    new URLSearchParams(await params),
    orgMemberParamsSchema
  );
  const { role } = await validateRequestBody(request, updateOrgMemberSchema);

  const membership = await changeMemberRole(id, userId, role);

  log.info('Org member role changed', {
    orgId: id,
    memberUserId: userId,
    role,
    actorUserId: session.user.id,
  });

  return successResponse(membership);
}, RESOURCE);

export const DELETE = withAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  if (isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to remove an org member', { userId: session.user.id });
    throw new ForbiddenError('Managing members requires a browser session');
  }

  const { id, userId } = validateQueryParams(
    new URLSearchParams(await params),
    orgMemberParamsSchema
  );

  const { revokedSessions } = await removeMember(id, userId);

  log.info('Org member removed', {
    orgId: id,
    memberUserId: userId,
    revokedSessions,
    actorUserId: session.user.id,
  });

  return successResponse({ orgId: id, userId, removed: true, revokedSessions });
}, RESOURCE);
