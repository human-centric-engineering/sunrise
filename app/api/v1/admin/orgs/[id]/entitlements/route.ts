/**
 * One org's entitlement switches (§135 t-1033)
 *
 * GET    /api/v1/admin/orgs/[id]/entitlements — every switch the app
 *        registers, whether this org has it, whether it was set on the org or
 *        is at its default, and whether this caller may change them.
 * PATCH  /api/v1/admin/orgs/[id]/entitlements — `{ on: string[], off: string[] }`:
 *        set the named registered switches on or off. A switch named in
 *        neither is left as it is.
 * DELETE /api/v1/admin/orgs/[id]/entitlements — put every registered switch
 *        back to its `whenNothingSet`.
 *
 * Naming only what it changes is what keeps a caller from turning off a switch
 * it did not know about: one registered after its form loaded, or by a newer
 * build during a deploy. For the same reason, values stored for keys no app
 * registers any more are kept by both writes (`setOrgSwitches`). A key the app
 * does not register is a 400. With nothing registered there is nothing to
 * set, and a write is a 409 (saying so when the app's registration failed).
 *
 * Platform-only: a switch is what an org has bought, and an org must not grant
 * it to itself. So, as with the caps, at `multi` a platform admin switched into
 * a customer's org may read the switches but not change them: the write comes
 * from the install org or an unbound admin API key
 * (`mayChangeOrgCommercialSettings`). Every write that changes something is in
 * the admin audit log (`org.entitlements.update`) with what it replaced; one
 * that changes nothing writes nothing.
 */

import type { NextRequest } from 'next/server';

import { withAdminAuth, type AuthenticatedSession } from '@/lib/auth/guards';
import { APIError, ErrorCodes } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  entitlementSwitchesFailed,
  registeredEntitlementSwitches,
  resolveOrgSwitches,
  setOrgSwitches,
} from '@/lib/tenancy/entitlements';
import { getTenantContext } from '@/lib/tenancy/context';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import {
  mayChangeOrgCommercialSettings,
  SHARED_SETTINGS_REFUSAL_CODE,
} from '@/lib/tenancy/shared-settings';
import {
  isSettingsWriteConflict,
  loadOrgEntitlements,
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

/** The words an admin sees when a customer org's context tries to change them. */
const SWITCHES_REFUSAL =
  "An organisation's switches can only be changed from the install organisation. Switch to the install organisation to make this change.";

/**
 * The switches as the API reports them, against what is registered now.
 * `mayChange` lets the page offer the form only where a save can land;
 * `registrationFailed` lets it say the app's switches failed to register,
 * rather than look like an install that has none.
 */
function describe(orgId: string, read: OrgEntitlementsRead, mayChange: boolean) {
  const resolved = resolveOrgSwitches(read);
  const on = new Set(resolved.on);
  const atDefault = new Set(resolved.atDefault);
  return {
    orgId,
    nothingSet: resolved.nothingSet,
    unreadable: resolved.unreadable,
    mayChange,
    registrationFailed: entitlementSwitchesFailed(),
    switches: registeredEntitlementSwitches().map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      whenNothingSet: s.whenNothingSet,
      // 'org' when the org's own admins may set it too (t-1054).
      setBy: s.setBy,
      on: on.has(s.key),
      atDefault: atDefault.has(s.key),
    })),
    unregistered: resolved.unregistered,
  };
}

/** What the audit log keeps of what is stored now: the keys set on and off, or `null` for none. */
function auditable(read: OrgEntitlementsRead) {
  return read.on.length === 0 && read.off.length === 0
    ? null
    : { on: [...read.on], off: [...read.off] };
}

/**
 * At `multi`, writes come from the install org or an unbound admin API key.
 * Asked before the body is read, so a caller who may not write is told where
 * to go rather than how to fix a request it cannot make.
 */
function refuseOutsideInstallOrg(
  log: Awaited<ReturnType<typeof getRouteLogger>>,
  session: AuthenticatedSession,
  id: string
): void {
  if (mayChangeOrgCommercialSettings(session.principal.credential)) return;
  log.warn('tenancy: refused an org switches write outside the install org', {
    orgId: id,
    actorUserId: session.user.id,
    activeOrgId: getTenantContext()?.orgId ?? null,
  });
  throw new APIError(SWITCHES_REFUSAL, ErrorCodes.FORBIDDEN, 403, {
    reason: SHARED_SETTINGS_REFUSAL_CODE,
  });
}

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const read = await loadOrgEntitlements(id);
  if (!read) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  return successResponse(
    describe(id, read, mayChangeOrgCommercialSettings(session.principal.credential))
  );
}, PLATFORM_ONLY);

/**
 * Both writes, once the caller is known to be allowed: set `change` (the
 * named switches), or with `null` put every registered switch back to its
 * default, and audit it.
 */
async function writeSwitches(
  request: NextRequest,
  log: Awaited<ReturnType<typeof getRouteLogger>>,
  session: AuthenticatedSession,
  id: string,
  change: { on: string[]; off: string[] } | null
): Promise<Response> {
  const registered = new Set(registeredEntitlementSwitches().map((s) => s.key));
  if (registered.size === 0) {
    return errorResponse(
      entitlementSwitchesFailed()
        ? "The app's entitlement switches failed to register, so there is nothing to set. The server log says why."
        : 'No entitlement switches are registered on this install, so there is nothing to set',
      { code: 'CONFLICT', status: 409 }
    );
  }
  const unknownSwitches = change
    ? [...change.on, ...change.off].filter((key) => !registered.has(key))
    : [];
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

  let written: Awaited<ReturnType<typeof setOrgSwitches>>;
  try {
    written = await setOrgSwitches(id, change);
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
  // A save that changed nothing wrote nothing, and is not a change to record.
  if (!written.changed) {
    return successResponse(describe(id, written.stored, true));
  }

  logAdminAction({
    userId: session.user.id,
    action: 'org.entitlements.update',
    entityType: 'org',
    entityId: id,
    // The org changed, which a platform admin may do from outside it (t-1005).
    actingOrgId: id,
    changes: {
      // `from` exactly as it was stored, so what a tidying write dropped (a
      // key that is not one, a slice that could not be read) is on the record.
      entitlements: { from: written.previousStored, to: auditable(written.stored) },
    },
    clientIp: getClientIP(request),
  });

  log.info('Org entitlement switches changed by admin', {
    orgId: id,
    reset: change === null,
    on: written.stored.on,
    off: written.stored.off,
    actorUserId: session.user.id,
  });

  // Refused above otherwise, so this caller may change them.
  return successResponse(describe(id, written.stored, true));
}

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  refuseOutsideInstallOrg(log, session, id);
  const body = await validateRequestBody(request, orgEntitlementsInputSchema);
  return writeSwitches(request, log, session, id, body);
}, PLATFORM_ONLY);

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  refuseOutsideInstallOrg(log, session, id);
  return writeSwitches(request, log, session, id, null);
}, PLATFORM_ONLY);
