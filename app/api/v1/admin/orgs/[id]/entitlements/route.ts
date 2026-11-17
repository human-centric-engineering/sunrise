/**
 * One org's entitlement switches (§135 t-1033)
 *
 * GET /api/v1/admin/orgs/[id]/entitlements — every switch the app registers,
 *     whether this org has it, and whether anything was ever set on the org.
 * PUT /api/v1/admin/orgs/[id]/entitlements — replace them:
 *     `{ switches: string[] | null }`, the registered switches that are on.
 *     `null` clears the org back to nothing set, so it gets each switch's
 *     `whenNothingSet` again. The key is required, so a replace cannot clear
 *     an org by leaving it out.
 *
 * A key the app does not register is a 400. Keys already stored on the org
 * that no app registers any more are kept by a replace: the caller can only
 * see and set what is registered, so a save must not drop what it could not
 * see (a process running older code, or a switch an app has stopped
 * registering). With nothing registered there is nothing to set, and a PUT is
 * a 409.
 *
 * Platform-only, as the provider policy and the caps are: a switch is what an
 * org has bought, and an org's own admins must not grant it to themselves.
 * Every replacement is in the admin audit log with what it replaced.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { registeredEntitlementSwitches, resolveOrgSwitches } from '@/lib/tenancy/entitlements';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import {
  isSettingsWriteConflict,
  readOrgEntitlements,
  writeOrgEntitlements,
  type OrgEntitlementsRead,
} from '@/lib/tenancy/org-settings';
import { orgEntitlementsInputSchema, orgIdParamSchema } from '@/lib/validations/tenancy';

const PLATFORM_ONLY = {
  // Ownership: no ownership decision — a vendor surface, platform admin only. See RouteOwnership in lib/auth/guards.ts.
  ownership: {
    decidedBy: 'nothing',
    because:
      'The vendor setting what one org has: the switches are the org’s, not any user’s, and the guard already limits this to platform admins.',
  },
} as const;

/** The switches as the API reports them, against what is registered now. */
function describe(orgId: string, read: OrgEntitlementsRead) {
  const resolved = resolveOrgSwitches(read);
  const on = new Set(resolved.on);
  return {
    orgId,
    nothingSet: resolved.nothingSet,
    unreadable: resolved.unreadable,
    switches: registeredEntitlementSwitches().map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      whenNothingSet: s.whenNothingSet,
      on: on.has(s.key),
    })),
    unregistered: resolved.unregistered,
  };
}

/** What the audit log keeps: the stored keys, or that nothing was set. */
function auditable(read: OrgEntitlementsRead) {
  if (!read.set) return { nothingSet: true };
  return read.unreadable ? { unreadable: true } : { switches: [...read.switches] };
}

export const GET = withAdminAuth<{ id: string }>(async (_request, _session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const org = await prisma.org.findUnique({ where: { id }, select: { settings: true } });
  if (!org) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  return successResponse(describe(id, readOrgEntitlements(org.settings, { orgId: id })));
}, PLATFORM_ONLY);

export const PUT = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const body = await validateRequestBody(request, orgEntitlementsInputSchema);

  const registered = new Set(registeredEntitlementSwitches().map((s) => s.key));
  if (registered.size === 0) {
    return errorResponse(
      'No entitlement switches are registered on this install, so there is nothing to set',
      { code: 'CONFLICT', status: 409 }
    );
  }
  const unknownSwitches = (body.switches ?? []).filter((key) => !registered.has(key));
  if (unknownSwitches.length > 0) {
    const message = `No switch has the key ${unknownSwitches.join(', ')}`;
    // A VALIDATION_ERROR's details are fields (lib/api/errors.ts), so the
    // message goes in the list shape and the keys ride beside it.
    return errorResponse(message, {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { errors: [{ path: 'switches', message }], unknownSwitches },
    });
  }

  let written: Awaited<ReturnType<typeof writeOrgEntitlements>>;
  try {
    written = await writeOrgEntitlements(id, (previous) => {
      if (body.switches === null) return null;
      // Keep what the caller could not see: stored keys nothing registers.
      const kept = previous.set ? previous.switches.filter((key) => !registered.has(key)) : [];
      return [...body.switches, ...kept];
    });
  } catch (error) {
    if (!isSettingsWriteConflict(error)) throw error;
    // Another write to this org's settings landed between our read and ours.
    // Nothing was written; the caller re-reads and retries.
    return errorResponse(
      "Another change to this org's settings was saved at the same time; retry",
      { code: 'CONFLICT', status: 409 }
    );
  }
  if (!written) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  logAdminAction({
    userId: session.user.id,
    action: 'org.entitlements.replace',
    entityType: 'org',
    entityId: id,
    // The org changed, which a platform admin may do from outside it (t-1005).
    actingOrgId: id,
    changes: {
      entitlements: { from: auditable(written.previous), to: auditable(written.stored) },
    },
    clientIp: getClientIP(request),
  });

  log.info('Org entitlement switches replaced by admin', {
    orgId: id,
    nothingSet: !written.stored.set,
    switches: written.stored.set ? written.stored.switches : null,
    actorUserId: session.user.id,
  });

  return successResponse(describe(id, written.stored));
}, PLATFORM_ONLY);
