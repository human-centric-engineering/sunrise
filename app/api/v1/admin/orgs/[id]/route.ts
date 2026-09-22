/**
 * One org, as the vendor sees it (§106 t-672)
 *
 * GET    /api/v1/admin/orgs/[id] — the org with its full roster and its
 *        `settings` column.
 * PATCH  /api/v1/admin/orgs/[id] — rename, re-slug, suspend, reinstate, or
 *        set this org's own retention windows:
 *        `{ name?, slug?, status?, settings?: { retention? } }`.
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
 *
 * **Retention windows are the vendor's to set for now** (§108 t-713). An org
 * admin gets no say until the org console (§111) exists to give them one, so
 * the slice is written here, behind `withAdminAuth`, and read back by the
 * member view as a validated slice rather than as the raw column.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import {
  orgIdParamSchema,
  updateOrgSchema,
  type OrgRetentionSlice,
} from '@/lib/validations/tenancy';
import { OrgLifecycleError, updateOrg } from '@/lib/tenancy/lifecycle';
import { loadRetentionWindows } from '@/lib/orchestration/retention-windows';
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
      settings: true,
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

  const incoherent = await incoherentRetentionPair(body.settings?.retention);
  if (incoherent) {
    return errorResponse(
      `Cost log retention (${incoherent.costLogRetentionDays} days) must be at least as long as execution retention (${incoherent.executionRetentionDays} days), or the cost breakdown empties out for executions you are still keeping`,
      { code: 'VALIDATION_ERROR', status: 400, details: incoherent }
    );
  }

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

/**
 * The one rule a retention slice cannot be checked against on its own: cost
 * logs must outlive the executions that reference them, or an execution still
 * on file reports spend whose breakdown has been deleted
 * (`warnOnIncoherentRetention`).
 *
 * Checked on the **effective** pair, because half of it may be inherited: an
 * org shortening only its cost-log window inherits the global execution
 * window, and the two together are what the sweep will act on. That is the
 * same check `PATCH /admin/orchestration/settings` makes against the persisted
 * row for a one-sided patch, one level down.
 *
 * It is not the whole guard, and cannot be: a later change to the global row
 * can make a stored slice incoherent without anyone touching the org. The
 * sweep's per-org warning is what catches that.
 *
 * @returns the offending pair, or `null` when the body sets no windows, clears
 *   them, or leaves a coherent combination.
 */
async function incoherentRetentionPair(
  slice: OrgRetentionSlice | null | undefined
): Promise<{ costLogRetentionDays: number; executionRetentionDays: number } | null> {
  if (slice === undefined || slice === null) return null;

  const globalWindows = await loadRetentionWindows();
  const costLogRetentionDays =
    slice.costLogRetentionDays !== undefined
      ? slice.costLogRetentionDays
      : globalWindows.costLogRetentionDays;
  const executionRetentionDays =
    slice.executionRetentionDays !== undefined
      ? slice.executionRetentionDays
      : globalWindows.executionRetentionDays;

  if (costLogRetentionDays === null || executionRetentionDays === null) return null;
  if (costLogRetentionDays >= executionRetentionDays) return null;
  return { costLogRetentionDays, executionRetentionDays };
}
