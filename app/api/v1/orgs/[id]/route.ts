/**
 * One org, as one of its members sees it (§106 t-672)
 *
 * GET /api/v1/orgs/[id] — the org's id / slug / name / status, the caller's
 * role in it, its member count, and the retention windows it has set for
 * itself. Any member may read it; a non-member gets the same `403 Access
 * denied` whether the org exists or not.
 *
 * **The validated `retention` slice, not the `settings` column** (§108 t-713).
 * `Org.settings` is one JSON object, and only the `retention` key in it is the
 * platform's: a fork keeps its own org config beside it, and the platform
 * cannot promise every key a fork puts there is safe for every MEMBER of the
 * org to read. So this route publishes what it can vouch for — the slice, read
 * through the same validator the sweep uses, `null` when the org has set
 * nothing. The whole column is on the platform-admin view.
 *
 * Self-scoped rather than `resource`-scoped, and the reason is the policy's
 * shape: with the org resolver the default policy's org arm admits the org's
 * OWNER/ADMIN and refuses a MEMBER, which is right for the members routes and
 * wrong here. What this route reads is the caller's OWN membership row —
 * the subject's data by `SUBJECT_DATA_SOURCES`' own account — with the org's
 * name riding on it, so it is keyed on `session.user.id` like `users/me`.
 */

import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { orgIdParamSchema } from '@/lib/validations/tenancy';
import { readOrgRetention } from '@/lib/tenancy/org-settings';
import { getRouteLogger } from '@/lib/api/context';

export const GET = withAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: id, userId: session.user.id } },
      select: {
        role: true,
        createdAt: true,
        org: {
          select: {
            id: true,
            slug: true,
            name: true,
            status: true,
            settings: true,
            createdAt: true,
            _count: { select: { memberships: true } },
          },
        },
      },
    });

    if (!membership) {
      // Same answer for "no such org" and "not a member" — the guard's own
      // wording for an unresolved resource, so nothing enumerates.
      log.warn('Org read refused: not a member', { userId: session.user.id, orgId: id });
      throw new ForbiddenError('Access denied');
    }

    const { _count, settings, ...org } = membership.org;
    return successResponse({
      ...org,
      settings: { retention: readOrgRetention(settings, { orgId: id }, log) },
      memberCount: _count.memberships,
      role: membership.role,
      joinedAt: membership.createdAt,
    });
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because:
        'Reads the caller’s own membership row by `(orgId, session.user.id)` and the org it points at; a non-member is refused before any org column is read.',
    },
  }
);
