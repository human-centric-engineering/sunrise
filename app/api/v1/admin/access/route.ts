/**
 * Who can do what in the admin console, for the caller (§143).
 *
 * GET /api/v1/admin/access
 *
 * The roles and tiers, the entitlement switches, the admin pages grouped into
 * areas with the tier and switch each needs, what the install keeps for the
 * platform, and the caller's own access in the org they entered: all derived
 * from the registrations that decide access (`lib/auth/access-explainer.ts`).
 * The explainer's own words and an app's catalogue keys are in the locale
 * the request resolves to (`lib/i18n/request.ts`); a switch's label,
 * description and refusal are shown as the app registered them.
 *
 * **Open to everyone the admin console admits, each to their own slice:** a
 * platform admin sees every registration, an org's OWNER/ADMIN their org's
 * view, and a holder of one of the app's named tiers only those tiers. The
 * narrowing happens before the response is built, so a holder's response
 * never carries another tier's pages. Anyone the console admits to nothing,
 * an org MEMBER included, is refused with a 403.
 *
 * `withAuth`, not `withAdminAuth`: no one tier admits all three kinds of
 * viewer, so the route asks the policy for the caller's whole reach
 * (`adminReachOf()`, the same answer the admin layout acts on) and refuses an
 * empty one itself.
 *
 * @see .context/auth/access-explainer.md
 */
import { getTranslations } from 'next-intl/server';

import { ForbiddenError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAuth } from '@/lib/auth/guards';
import { adminReachOf, lockedSwitchesIn } from '@/lib/auth/admin-reach';
import { isSupportEntry } from '@/lib/auth/support-principal';
import {
  accessAudienceOf,
  buildAccessExplainer,
  type AccessTranslator,
} from '@/lib/auth/access-explainer';
import { loadOrgSwitches, type OrgSwitches } from '@/lib/tenancy/entitlements';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';

export const GET = withAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);
    const { principal } = session;
    // The scope the guards build for the org the request entered.
    const scope = principal.orgId ? { org: principal.orgId } : {};
    const reach = await adminReachOf(principal, scope);
    if (accessAudienceOf(reach) === null) {
      throw new ForbiddenError('Access denied');
    }

    const orgId = reach === 'platform' ? undefined : principal.orgId;
    // One read of the org's switches, so what the org has and what it is
    // shown locked come from the same answer.
    const org = await readOrgSwitches(orgId, log);
    const locked = org === 'failed' ? [] : lockedSwitchesIn(reach, org);
    const switchesOn = switchesOnOf(org);

    const t = await getTranslations();
    const translate: AccessTranslator = Object.assign(
      (key: string) => t(key as Parameters<typeof t>[0]),
      { has: (key: string) => t.has(key as Parameters<typeof t>[0]) }
    );
    const explainer = buildAccessExplainer(
      {
        reach,
        orgRole: principal.orgRole ?? null,
        switchesOn,
        locked,
        // The guard entered the org under a support grant (§121 t-824).
        supportEntry: isSupportEntry(getTenantContext()),
        multiTenant: isMultiTenant(),
      },
      translate
    );
    if (explainer === null) throw new ForbiddenError('Access denied');
    return successResponse(explainer);
  },
  {
    // A key reaches it only with the `admin` scope: the explainer maps the
    // org's admin console, which a key minted for chat or capture should not.
    scope: 'admin',
    ownership: {
      decidedBy: 'self',
      because:
        "returns only the caller's own access, worked out by the policy from their own session and the org it entered; the registrations it describes are the install's, not anyone's rows",
    },
  }
);

/**
 * The org's switches: `null` outside an org or for an org that does not
 * exist, `'failed'` when the read threw (logged here).
 */
async function readOrgSwitches(
  orgId: string | undefined,
  log: Awaited<ReturnType<typeof getRouteLogger>>
): Promise<OrgSwitches | null | 'failed'> {
  if (!orgId) return null;
  try {
    return await loadOrgSwitches(orgId);
  } catch (error) {
    log.error("access explainer: could not read the org's switches", {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/**
 * The switches the org has, or `null` outside an org or when they could not
 * be read: the explainer then says it could not explain a locked page,
 * rather than guess. An org whose row has gone while the session still names
 * it counts as unread, not as an org with no switches: the two disagree, and
 * "none" would be a guess.
 */
function switchesOnOf(org: OrgSwitches | null | 'failed'): readonly string[] | null {
  return org === null || org === 'failed' || org.unreadable ? null : org.on;
}
