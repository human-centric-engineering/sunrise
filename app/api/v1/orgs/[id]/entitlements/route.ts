/**
 * The switches an org's own admins may set (§135 t-1054)
 *
 * GET   /api/v1/orgs/[id]/entitlements — every switch the app registers
 *       `setBy: 'org'`, whether this org has it and whether it is at its
 *       default, and whether this caller may change them.
 * PATCH /api/v1/orgs/[id]/entitlements — `{ on: string[], off: string[] }`:
 *       set the named switches on or off. A switch named in neither is left
 *       as it is.
 *
 * Most switches are something an org bought, and only platform staff set
 * those (`/api/v1/admin/orgs/[id]/entitlements`). A switch an app registers
 * `setBy: 'org'` is not bought (a beta opt-in, a free add-on, a feature an
 * org may turn off for its own users), so the org's own admins may set it
 * here, for their own org. Naming a switch that is platform-set is a 403,
 * whoever asks: this route never sets what an org buys.
 *
 * Who may call it is the authorization policy's decision, about the resource
 * `{ kind: 'org.switches', id, orgId }` (`ORG_SWITCHES_RESOURCE_KIND`): by
 * default the org's OWNER and ADMIN while they act in it, so an app's policy
 * can narrow it. On top of the policy the caller must be acting in this org,
 * with a browser session. A support session may read them but not change
 * them: they are the org's own choice. Every write that changes something is
 * in the admin audit log as `org.entitlements.update`, as the platform's
 * writes are, with `metadata.setBy: 'org'`.
 */

import type { NextRequest } from 'next/server';

import { withAuth, type AuthenticatedSession } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { isSupportEntry } from '@/lib/auth/support-principal';
import { APIError, ErrorCodes, ForbiddenError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  entitlementSwitchesFailed,
  ORG_SWITCHES_RESOURCE_KIND,
  OrgSwitchesUnreadableError,
  orgSettableSwitches,
  registeredEntitlementSwitches,
  resolveOrgSwitches,
  setOrgSwitches,
} from '@/lib/tenancy/entitlements';
import { getTenantContext } from '@/lib/tenancy/context';
import { OrgLifecycleError, resolveOrgResource } from '@/lib/tenancy/lifecycle';
import {
  isSettingsWriteConflict,
  loadOrgEntitlements,
  type OrgEntitlementsRead,
} from '@/lib/tenancy/org-settings';
import { orgEntitlementsInputSchema, orgIdParamSchema } from '@/lib/validations/tenancy';

/** `details.reason` on the 403 for naming a switch only platform staff may set. */
const PLATFORM_SET_REASON = 'switch_set_by_platform';

const RESOURCE = {
  resource: async (_request: unknown, context?: { params: Promise<{ id: string }> }) => {
    const org = await resolveOrgResource(await context?.params);
    return org ? { kind: ORG_SWITCHES_RESOURCE_KIND, id: org.id, orgId: org.orgId } : null;
  },
  ownership: {
    decidedBy: 'resource',
    because:
      'The policy admitted the caller to the switches of the org the URL names; the handlers read and write that org’s switches only.',
  },
} as const;

/**
 * Refuse a caller the policy admitted who may still not act on this org's
 * switches: an API key (setting them is a person's choice), or someone not
 * acting in this org (a platform admin elsewhere uses the platform route).
 */
function assertActsForOrg(session: AuthenticatedSession, orgId: string): void {
  if (isApiKeySession(session)) {
    throw new ForbiddenError('Changing an organisation’s switches requires a browser session');
  }
  if (session.principal.orgId !== orgId) {
    throw new ForbiddenError('Switch to this organisation to see or change its switches');
  }
}

/** Whether this request runs in a support session (§121), which may read but not write. */
function inSupportSession(): boolean {
  return isSupportEntry(getTenantContext());
}

/** The org-settable switches as the API reports them, against what is registered now. */
function describe(orgId: string, read: OrgEntitlementsRead) {
  const resolved = resolveOrgSwitches(read);
  const on = new Set(resolved.on);
  const atDefault = new Set(resolved.atDefault);
  return {
    orgId,
    unreadable: resolved.unreadable,
    mayChange: !inSupportSession() && !resolved.unreadable,
    registrationFailed: entitlementSwitchesFailed(),
    switches: orgSettableSwitches().map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      whenNothingSet: s.whenNothingSet,
      on: on.has(s.key),
      atDefault: atDefault.has(s.key),
    })),
  };
}

export const GET = withAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  assertActsForOrg(session, id);

  const read = await loadOrgEntitlements(id);
  if (!read) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
  return successResponse(describe(id, read));
}, RESOURCE);

export const PATCH = withAuth<{ id: string }>(async (request: NextRequest, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  assertActsForOrg(session, id);
  if (inSupportSession()) {
    throw new ForbiddenError('Support staff cannot change an organisation’s own switches');
  }
  const change = await validateRequestBody(request, orgEntitlementsInputSchema);

  const settable = new Set(orgSettableSwitches().map((s) => s.key));
  if (settable.size === 0) {
    return errorResponse(
      entitlementSwitchesFailed()
        ? "The app's entitlement switches failed to register, so there is nothing to set. The server log says why."
        : 'No switch on this install can be set by an organisation, so there is nothing to set',
      { code: 'CONFLICT', status: 409 }
    );
  }
  const named = [...change.on, ...change.off];
  const registered = new Set(registeredEntitlementSwitches().map((s) => s.key));
  const unknownSwitches = named.filter((key) => !registered.has(key));
  if (unknownSwitches.length > 0) {
    const message = `No switch has the key ${unknownSwitches.join(', ')}`;
    return errorResponse(message, {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { errors: [{ path: 'switches', message }], unknownSwitches },
    });
  }
  const platformSet = named.filter((key) => !settable.has(key));
  if (platformSet.length > 0) {
    log.warn('tenancy: refused an org admin setting a platform-set switch', {
      orgId: id,
      actorUserId: session.user.id,
      switches: platformSet,
    });
    throw new APIError(
      `Only platform staff can change ${platformSet.join(', ')}. Ask whoever manages your organisation's account.`,
      ErrorCodes.FORBIDDEN,
      403,
      { reason: PLATFORM_SET_REASON, switches: platformSet }
    );
  }

  let written: Awaited<ReturnType<typeof setOrgSwitches>>;
  try {
    written = await setOrgSwitches(id, change, undefined, { refuseUnreadable: true });
  } catch (error) {
    if (error instanceof OrgSwitchesUnreadableError) {
      return errorResponse(
        "This organisation's switches could not be read, so none was changed. Ask whoever manages your organisation's account to look at them.",
        { code: 'CONFLICT', status: 409, details: { reason: 'switches_unreadable' } }
      );
    }
    if (!isSettingsWriteConflict(error)) throw error;
    return errorResponse(
      "Another change to this organisation's settings was saved at the same time; retry",
      { code: 'CONFLICT', status: 409 }
    );
  }
  if (!written) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
  if (!written.changed) return successResponse(describe(id, written.stored));

  logAdminAction({
    userId: session.user.id,
    action: 'org.entitlements.update',
    entityType: 'org',
    entityId: id,
    actingOrgId: id,
    changes: {
      entitlements: {
        from: written.previousStored,
        to:
          written.stored.on.length === 0 && written.stored.off.length === 0
            ? null
            : { on: [...written.stored.on], off: [...written.stored.off] },
      },
    },
    metadata: { setBy: 'org', on: change.on, off: change.off },
    clientIp: getClientIP(request),
  });
  log.info('Org switches changed by the org', {
    orgId: id,
    on: change.on,
    off: change.off,
    actorUserId: session.user.id,
  });

  return successResponse(describe(id, written.stored));
}, RESOURCE);
