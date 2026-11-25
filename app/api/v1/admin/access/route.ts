/**
 * Who can do what in the admin console, for the caller (§143).
 *
 * GET /api/v1/admin/access
 *
 * The roles and tiers, the entitlement switches, the admin pages grouped into
 * areas with the tier and switch each needs, what the install keeps for the
 * platform, and the caller's own access in the org they entered: all derived
 * from the registrations that decide access (`lib/auth/access-explainer.ts`),
 * in the caller's language.
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
import { adminReachOf, lockedSwitchesOf } from '@/lib/auth/admin-reach';
import {
  accessAudienceOf,
  buildAccessExplainer,
  type AccessTranslator,
} from '@/lib/auth/access-explainer';
import { loadOrgSwitches } from '@/lib/tenancy/entitlements';
import { isMultiTenant } from '@/lib/tenancy/context';

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
    const [locked, switchesOn] = await Promise.all([
      lockedSwitchesOf(reach, orgId),
      orgSwitchesOn(orgId, log),
    ]);

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
        multiTenant: isMultiTenant(),
      },
      translate
    );
    if (explainer === null) throw new ForbiddenError('Access denied');
    return successResponse(explainer);
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        "returns only the caller's own access, worked out by the policy from their own session and the org it entered; the registrations it describes are the install's, not anyone's rows",
    },
  }
);

/**
 * The switches the org has, or `null` outside an org or when they could not
 * be read: the explainer then says it could not explain a locked page,
 * rather than guess.
 */
async function orgSwitchesOn(
  orgId: string | undefined,
  log: Awaited<ReturnType<typeof getRouteLogger>>
): Promise<readonly string[] | null> {
  if (!orgId) return null;
  try {
    const org = await loadOrgSwitches(orgId);
    return org && !org.unreadable ? org.on : null;
  } catch (error) {
    log.error("access explainer: could not read the org's switches", {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
