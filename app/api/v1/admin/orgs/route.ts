/**
 * Orgs, as the vendor sees them (§106 t-672)
 *
 * GET  /api/v1/admin/orgs — every org with its member and owner counts, the
 *      enriched list the admin page reads in one request.
 * POST /api/v1/admin/orgs — create one: `{ slug, name, ownerUserId? }`,
 *      naming the founding OWNER in the same write.
 *
 * The platform view of the control-plane split (`.context/architecture/
 * multi-tenancy.md`, "which admin surfaces are whose"): creating, suspending
 * and deleting an org are the vendor's acts, so these routes are
 * `withAdminAuth` and platform-only. Membership *within* an org is the
 * customer's, at `/api/v1/orgs/[id]/members`.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { createOrgSchema } from '@/lib/validations/tenancy';
import { createOrg } from '@/lib/tenancy/lifecycle';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { getRouteLogger } from '@/lib/api/context';

const PLATFORM_ONLY = {
  // Ownership: no ownership decision — a vendor surface, platform admin only. See RouteOwnership in lib/auth/guards.ts.
  ownership: {
    decidedBy: 'nothing',
    because:
      'The vendor’s view of every org: orgs are not owned by a user, and the guard already limits this to platform admins.',
  },
} as const;

export const GET = withAdminAuth(async () => {
  const orgs = await prisma.org.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { memberships: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Owner counts in one query rather than one per row: an org with no
  // OWNER is the state the admin page needs to flag.
  const owners = await prisma.orgMembership.groupBy({
    by: ['orgId'],
    where: { role: ORG_OWNER_ROLE },
    _count: { _all: true },
  });
  const ownerCount = new Map(owners.map((row) => [row.orgId, row._count._all]));

  return successResponse({
    orgs: orgs.map(({ _count, ...org }) => ({
      ...org,
      memberCount: _count.memberships,
      ownerCount: ownerCount.get(org.id) ?? 0,
    })),
  });
}, PLATFORM_ONLY);

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createOrgSchema);

  const org = await createOrg(body);

  log.info('Org created by admin', {
    orgId: org.id,
    slug: org.slug,
    ownerUserId: body.ownerUserId ?? null,
    actorUserId: session.user.id,
  });

  return successResponse(org, undefined, { status: 201 });
}, PLATFORM_ONLY);
