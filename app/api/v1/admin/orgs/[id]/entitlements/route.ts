/**
 * One org's entitlement switches (§135 t-1033)
 *
 * GET /api/v1/admin/orgs/[id]/entitlements — every switch the app registers,
 *     whether this org has it, whether it was set on the org or is at its
 *     default, and whether this caller may change them.
 * PUT /api/v1/admin/orgs/[id]/entitlements — replace them:
 *     `{ switches: string[] | null }`, the registered switches that are on;
 *     every other registered switch is set off. `null` sets none, so every
 *     registered switch is back at its `whenNothingSet`. The key is required,
 *     so a replace cannot clear an org by leaving it out.
 *
 * A key the app does not register is a 400. Values already stored on the org
 * for keys no app registers any more are kept by a replace, on or off: the
 * caller can only see and set what is registered, so a save must not drop
 * what it could not see (a process running older code, or a switch an app has
 * stopped registering). A switch registered after the save is not set by it,
 * so it reaches the org at its default. With nothing registered there is
 * nothing to set, and a PUT is a 409.
 *
 * Platform-only: a switch is what an org has bought, and an org must not grant
 * it to itself. So, as with the caps, at `multi` a platform admin switched into
 * a customer's org may read the switches but not change them: the write comes
 * from the install org or an unbound admin API key
 * (`mayChangeOrgCommercialSettings`). Every replacement is in the admin audit
 * log with what it replaced.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { APIError, ErrorCodes } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { registeredEntitlementSwitches, resolveOrgSwitches } from '@/lib/tenancy/entitlements';
import { getTenantContext } from '@/lib/tenancy/context';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import {
  mayChangeOrgCommercialSettings,
  SHARED_SETTINGS_REFUSAL_CODE,
} from '@/lib/tenancy/shared-settings';
import {
  isSettingsWriteConflict,
  loadOrgEntitlements,
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

/** The words an admin sees when a customer org's context tries to change them. */
const SWITCHES_REFUSAL =
  "An organisation's switches can only be changed from the install organisation. Switch to the install organisation to make this change.";

/**
 * The switches as the API reports them, against what is registered now.
 * `mayChange` lets the page offer the form only where a save can land.
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
    switches: registeredEntitlementSwitches().map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      whenNothingSet: s.whenNothingSet,
      on: on.has(s.key),
      atDefault: atDefault.has(s.key),
    })),
    unregistered: resolved.unregistered,
  };
}

/** What the audit log keeps: the keys set on and off, or that they could not be read. */
function auditable(read: OrgEntitlementsRead) {
  return read.unreadable ? { unreadable: true } : { on: [...read.on], off: [...read.off] };
}

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const read = await loadOrgEntitlements(id);
  if (!read) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  return successResponse(
    describe(id, read, mayChangeOrgCommercialSettings(session.principal.credential))
  );
}, PLATFORM_ONLY);

export const PUT = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const body = await validateRequestBody(request, orgEntitlementsInputSchema);

  // Before anything that says which switches exist.
  if (!mayChangeOrgCommercialSettings(session.principal.credential)) {
    log.warn('tenancy: refused an org switches write outside the install org', {
      orgId: id,
      actorUserId: session.user.id,
      activeOrgId: getTenantContext()?.orgId ?? null,
    });
    throw new APIError(SWITCHES_REFUSAL, ErrorCodes.FORBIDDEN, 403, {
      reason: SHARED_SETTINGS_REFUSAL_CODE,
    });
  }

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
      // Keep what the caller could not see: values stored for keys nothing registers.
      const unseen = (keys: readonly string[]) => keys.filter((key) => !registered.has(key));
      const keptOn = unseen(previous.on);
      const keptOff = unseen(previous.off);
      if (body.switches === null) return { on: keptOn, off: keptOff };
      const ticked = new Set(body.switches);
      return {
        on: [...ticked, ...keptOn],
        off: [...[...registered].filter((key) => !ticked.has(key)), ...keptOff],
      };
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
    on: written.stored.on,
    off: written.stored.off,
    actorUserId: session.user.id,
  });

  // Refused above otherwise, so this caller may change them.
  return successResponse(describe(id, written.stored, true));
}, PLATFORM_ONLY);
