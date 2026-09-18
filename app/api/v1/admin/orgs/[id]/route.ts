/**
 * One org, as the vendor sees it (§106 t-672)
 *
 * GET    /api/v1/admin/orgs/[id] — the org with its full roster.
 * PATCH  /api/v1/admin/orgs/[id] — rename, re-slug, suspend or reinstate:
 *        `{ name?, slug?, status? }`.
 * DELETE /api/v1/admin/orgs/[id] — erase it (`eraseOrg`): the org, its
 *        memberships, its credentials and its pending invitations go; its
 *        members' accounts stay.
 *
 * Platform-only, like the sibling list route — the vendor's half of the
 * control-plane split. The rules — the install org can be renamed but never
 * suspended, re-slugged or deleted — are `lib/tenancy/lifecycle.ts`'s and
 * `lib/privacy/erase-org.ts`'s, and their errors carry their own status.
 *
 * A platform admin suspending an org whose members are signed in does not
 * sign them out: the guard refuses their next request into it, and
 * `POST /api/v1/orgs/switch` remains their way to another org.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { orgIdParamSchema, updateOrgSchema } from '@/lib/validations/tenancy';
import { OrgLifecycleError, updateOrg } from '@/lib/tenancy/lifecycle';
import { eraseOrg } from '@/lib/privacy/erase-org';
import { getRouteLogger } from '@/lib/api/context';

const PLATFORM_ONLY = {
  // Ownership: no ownership decision — a vendor surface, platform admin only. See RouteOwnership in lib/auth/guards.ts.
  ownership: {
    decidedBy: 'nothing',
    because:
      'The vendor acting on one org: orgs are not owned by a user, and the guard already limits this to platform admins.',
  },
} as const;

export const GET = withAdminAuth<{ id: string }>(async (_request, _session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const org = await prisma.org.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      memberships: {
        select: {
          role: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true, image: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!org) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  const { memberships, ...rest } = org;
  return successResponse({
    ...rest,
    members: memberships.map((membership) => ({
      ...membership.user,
      role: membership.role,
      joinedAt: membership.createdAt,
    })),
  });
}, PLATFORM_ONLY);

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const body = await validateRequestBody(request, updateOrgSchema);

  const org = await updateOrg(id, body);

  log.info('Org updated by admin', {
    orgId: id,
    changes: Object.keys(body),
    ...(body.status !== undefined && { status: body.status }),
    actorUserId: session.user.id,
  });

  return successResponse(org);
}, PLATFORM_ONLY);

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const result = await eraseOrg({ orgId: id, actorUserId: session.user.id });

  log.info('Org erased by admin', { orgId: id, actorUserId: session.user.id, ...result });

  return successResponse({ orgId: id, ...result });
}, PLATFORM_ONLY);
