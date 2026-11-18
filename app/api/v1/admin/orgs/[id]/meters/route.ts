/**
 * One org's meters and their limits (§135 t-1035)
 *
 * GET   /api/v1/admin/orgs/[id]/meters — every meter (the platform's seats,
 *       then the app's), how many the org has within its window, its limit,
 *       and whether this caller may change the limits.
 * PATCH /api/v1/admin/orgs/[id]/meters — `{ limits: { [key]: number | null } }`:
 *       set the named meters' limits, `null` to clear one. A meter not named
 *       is left as it is.
 *
 * Naming only what it changes is what keeps a caller from clearing a limit it
 * did not know about: one for a meter registered after its form loaded, or by
 * a newer build during a deploy. Limits stored for keys nothing registers any
 * more are kept, and may be cleared by naming them with `null`; setting one is
 * a 400, as is any key nothing registers.
 *
 * Platform-only: a limit is part of what an org has bought, and an org must not
 * raise its own. So, as with the caps and the switches, at `multi` a platform
 * admin switched into a customer's org may read the limits but not change
 * them: the write comes from the install org or an unbound admin API key
 * (`mayChangeOrgCommercialSettings`). Every write that changes something is in
 * the admin audit log (`org.meters.update`) with what it replaced; one that
 * changes nothing writes nothing.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { APIError, ErrorCodes } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { entitlementSwitchesFailed } from '@/lib/tenancy/entitlements';
import { getTenantContext } from '@/lib/tenancy/context';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import { allMeters, loadOrgMeterUsage } from '@/lib/tenancy/meters';
import {
  mayChangeOrgCommercialSettings,
  SHARED_SETTINGS_REFUSAL_CODE,
} from '@/lib/tenancy/shared-settings';
import { isSettingsWriteConflict, writeOrgMeterLimits } from '@/lib/tenancy/org-settings';
import { orgIdParamSchema, orgMeterLimitsInputSchema } from '@/lib/validations/tenancy';

const PLATFORM_ONLY = {
  // Ownership: no ownership decision — a vendor surface, platform admin only. See RouteOwnership in lib/auth/guards.ts.
  ownership: {
    decidedBy: 'nothing',
    because:
      'The vendor setting what one org may use: the limits are the org’s, not any user’s, and the guard already limits this to platform admins.',
  },
} as const;

/** The words an admin sees when a customer org's context tries to change them. */
const METERS_REFUSAL =
  "An organisation's limits can only be changed from the install organisation. Switch to the install organisation to make this change.";

/** The meters as the API reports them; `null` when there is no such org. */
async function describe(orgId: string, mayChange: boolean) {
  const usage = await loadOrgMeterUsage(orgId);
  if (!usage) return null;
  return {
    orgId,
    mayChange,
    registrationFailed: entitlementSwitchesFailed(),
    meters: usage.meters,
    unregistered: usage.unregistered,
  };
}

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const described = await describe(
    id,
    mayChangeOrgCommercialSettings(session.principal.credential)
  );
  if (!described) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
  return successResponse(described);
}, PLATFORM_ONLY);

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  // Asked before the body is read, so a caller who may not write is told
  // where to go rather than how to fix a request it cannot make.
  if (!mayChangeOrgCommercialSettings(session.principal.credential)) {
    log.warn('tenancy: refused an org meter limits write outside the install org', {
      orgId: id,
      actorUserId: session.user.id,
      activeOrgId: getTenantContext()?.orgId ?? null,
    });
    throw new APIError(METERS_REFUSAL, ErrorCodes.FORBIDDEN, 403, {
      reason: SHARED_SETTINGS_REFUSAL_CODE,
    });
  }

  const { limits } = await validateRequestBody(request, orgMeterLimitsInputSchema);

  // Clearing a key nothing registers is how a kept limit is tidied away;
  // setting one would store a limit nothing reads.
  const registered = new Set(allMeters().map((m) => m.key));
  const unknownMeters = Object.entries(limits)
    .filter(([key, limit]) => limit !== null && !registered.has(key))
    .map(([key]) => key);
  if (unknownMeters.length > 0) {
    const message = `No meter has the key ${unknownMeters.join(', ')}`;
    // A VALIDATION_ERROR's details are fields (lib/api/errors.ts), so the
    // message goes in the list shape and the keys ride beside it.
    return errorResponse(message, {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { errors: [{ path: 'limits', message }], unknownMeters },
    });
  }

  let written: Awaited<ReturnType<typeof writeOrgMeterLimits>>;
  try {
    written = await writeOrgMeterLimits(id, limits);
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
  if (written.changed) {
    logAdminAction({
      userId: session.user.id,
      action: 'org.meters.update',
      entityType: 'org',
      entityId: id,
      // The org changed, which a platform admin may do from outside it (t-1005).
      actingOrgId: id,
      changes: {
        meterLimits: {
          from: Object.keys(written.previous).length === 0 ? null : written.previous,
          to: Object.keys(written.stored).length === 0 ? null : written.stored,
        },
      },
      clientIp: getClientIP(request),
    });

    log.info('Org meter limits changed by admin', {
      orgId: id,
      limits: written.stored,
      actorUserId: session.user.id,
    });
  }

  // Refused above otherwise, so this caller may change them.
  const described = await describe(id, true);
  if (!described) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
  return successResponse(described);
}, PLATFORM_ONLY);
