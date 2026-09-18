/**
 * An org's members, for the people who administer it (§106 t-672)
 *
 * GET  /api/v1/orgs/[id]/members — the roster: each member's id / name /
 *      email / image, their org role and when they joined.
 * POST /api/v1/orgs/[id]/members — add an existing user: `{ userId, role? }`.
 *
 * Who may call these is the authorization policy's decision, not this
 * file's: every route here hands the guard `resource: { kind: 'org', id,
 * orgId: id }` (`resolveOrgResource`), and the default policy's org arm
 * admits the org's OWNER / ADMIN **while acting in it** — the session's
 * active org, or the proxy's resolver header — and a platform admin from
 * anywhere. A MEMBER, a member of another org, and a caller naming an org
 * that does not exist all get one `403 Access denied`. There is no role
 * check in this file, by design: a fork that widens or narrows the org arm
 * changes who reaches these handlers without touching them.
 *
 * The handlers read and write nothing outside the resolved org — that is
 * the `ownership: 'resource'` claim, and the roster is filtered by the
 * resolved id rather than by anything the caller sent. The rules — the
 * install org's roles follow the platform role, an org keeps an OWNER, only
 * an OWNER confers OWNER — are `lib/tenancy/lifecycle.ts`'s, and its errors
 * carry their own status. The one thing the routes hand it about the caller
 * is their standing (`actorOf`): platform admin, or their verified role in
 * this org off the principal the guard built.
 *
 * Every route here needs a browser session — the roster is people, and the
 * writes are the org's shape: a credential is narrower than its owner and
 * none of the scopes mean "manage the org" (the same refusal as minting a
 * key over a key). The policy's org arm already refuses a non-admin key; the
 * check here is what also keeps an `admin` key — a platform credential the
 * policy admits everywhere — to the platform view.
 */

import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { orgIdParamSchema, addOrgMemberSchema } from '@/lib/validations/tenancy';
import { addMember, resolveOrgResource, type MembershipActor } from '@/lib/tenancy/lifecycle';
import { isPlatformAdmin } from '@/lib/auth/roles';
import { getRouteLogger } from '@/lib/api/context';

const RESOURCE = {
  resource: async (_request: unknown, context?: { params: Promise<{ id: string }> }) =>
    resolveOrgResource(await context?.params),
  // Ownership: the policy decided about the org the resolver named, and the
  // handlers read nothing outside it — see RouteOwnership in lib/auth/guards.ts.
  ownership: {
    decidedBy: 'resource',
    because:
      'The policy admitted the caller to the org the URL names; the roster is filtered by that resolved id and the writes are keyed on it.',
  },
} as const;

/** The caller's standing for the ownership rule, from what the guard verified. */
function actorOf(session: {
  user: { role?: string | null };
  principal: { orgRole?: string | null };
}): MembershipActor {
  return { platformAdmin: isPlatformAdmin(session.user), orgRole: session.principal.orgRole };
}

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  if (isApiKeySession(session)) {
    const log = await getRouteLogger(request);
    log.warn('Rejected API-key attempt to read an org roster', { userId: session.user.id });
    throw new ForbiddenError('Reading members requires a browser session');
  }

  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const members = await prisma.orgMembership.findMany({
    where: { orgId: id },
    select: {
      role: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return successResponse({
    orgId: id,
    members: members.map((membership) => ({
      ...membership.user,
      role: membership.role,
      joinedAt: membership.createdAt,
    })),
  });
}, RESOURCE);

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  if (isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to add an org member', { userId: session.user.id });
    throw new ForbiddenError('Managing members requires a browser session');
  }

  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const body = await validateRequestBody(request, addOrgMemberSchema);

  const membership = await addMember(id, body.userId, body.role, actorOf(session));

  log.info('Org member added', {
    orgId: id,
    memberUserId: body.userId,
    role: membership.role,
    actorUserId: session.user.id,
  });

  return successResponse(membership, undefined, { status: 201 });
}, RESOURCE);
