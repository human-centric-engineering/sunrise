/**
 * What one principal may open in the admin console, worked out from the
 * policy (§143, moved here from `lib/auth/admin-page-viewer.ts`).
 *
 * The admin layout asks it for the request it is rendering
 * (`requestAdminReach()`, `requestLockedSwitches()`), and an API route asks it
 * for the principal its guard built (`GET /api/v1/admin/access`). One
 * function, so a page and a route cannot disagree about who opens what.
 *
 * Every answer is the policy's: `canAdminister` asked once per tier with the
 * principal and scope the guards build, then once per switch a page requires
 * for each tier it admitted. Nothing here decides access on its own.
 *
 * @see lib/auth/admin-page-viewer.ts — the per-request, cached readers
 * @see lib/auth/admin-tier.ts — `AdminReach`, `reachesTier()`
 */
import { canAdminister } from '@/lib/auth/authorization';
import type { AuthorizationPrincipal, AuthorizationScope } from '@/lib/auth/authorization';
import type {
  AdminReach,
  AdminSwitchGrant,
  DeclaredAdminTier,
  LockedAdminSwitch,
} from '@/lib/auth/admin-tier';
import { reachesTier } from '@/lib/auth/admin-tier';
import { adminPageRequirements, namedAdminTiers } from '@/lib/auth/org-tier-admin-pages';
import { heldTierLanding } from '@/lib/auth/admin-landing';
import { logger } from '@/lib/logging';
import {
  loadOrgSwitches,
  registeredEntitlementSwitches,
  switchRequiredMessage,
  type OrgSwitches,
} from '@/lib/tenancy/entitlements';

/**
 * Does this principal administer the platform, in the org they entered? The
 * policy asked with no resource and no tier: the question every platform-only
 * surface asks.
 */
export function administersPlatformIn(
  principal: AuthorizationPrincipal,
  scope: AuthorizationScope
): Promise<boolean> {
  return canAdminister(principal, null, scope);
}

/**
 * The tiers the policy admits a principal who is NOT a platform admin to, in
 * the org they entered: `'org'` and each named tier the fork registered, with
 * the switch requirements met for each, and where `/admin` sends a holder of
 * named tiers. Ask {@link administersPlatformIn} first; this does not.
 */
export async function orgAdminReachOf(
  principal: AuthorizationPrincipal,
  scope: AuthorizationScope
): Promise<Exclude<AdminReach, 'platform'>> {
  const candidates: DeclaredAdminTier[] = ['org', ...namedAdminTiers()];
  const admitted = await Promise.all(
    candidates.map((tier) => canAdminister(principal, null, { ...scope, tier }))
  );
  const tiers = candidates.filter((_, i) => admitted[i]);
  const required = [...new Set(adminPageRequirements().map((r) => r.requires))];
  const asked: AdminSwitchGrant[] = required.flatMap((requires) =>
    tiers.map((tier) => ({ tier, requires }))
  );
  const met = await Promise.all(
    asked.map((grant) => canAdminister(principal, null, { ...scope, ...grant }))
  );
  const switchesMet = asked.filter((_, i) => met[i]);
  // A landing that requires a switch is this viewer's only if their org has it.
  const landing = tiers.includes('org')
    ? null
    : heldTierLanding(tiers, (tier, requires) =>
        reachesTier({ tiers, landing: null, switchesMet }, tier, requires)
      );
  // With no switch to ask about, the reach is exactly what it was before them.
  if (asked.length === 0) return { tiers, landing };
  return { tiers, landing, switchesMet };
}

/** Everything a principal may open: `'platform'`, or {@link orgAdminReachOf}. */
export async function adminReachOf(
  principal: AuthorizationPrincipal,
  scope: AuthorizationScope
): Promise<AdminReach> {
  if (await administersPlatformIn(principal, scope)) return 'platform';
  return orgAdminReachOf(principal, scope);
}

/**
 * The switches an org lacks that the app shows locked rather than hidden
 * (§135 t-1053), for a viewer with this reach in that org. Empty for a
 * platform reach, whom switches do not limit, for a reach of nothing, and on
 * an install where no page requires a switch registered `whenLacking:
 * 'lock'`, so nothing more is read there.
 *
 * Only a switch the org's switches were read for and found off is here. One
 * the org has (the policy refused for another reason), or whose read failed,
 * is left out, so its surfaces stay hidden rather than tell an admin to buy
 * something their org may have. One read of the org's switches.
 */
export async function lockedSwitchesOf(
  reach: AdminReach,
  orgId: string | null | undefined
): Promise<readonly LockedAdminSwitch[]> {
  if (lockableSwitches(reach).length === 0) return [];
  if (!orgId) return [];
  let org: OrgSwitches | null;
  try {
    org = await loadOrgSwitches(orgId);
  } catch (error) {
    logger.error("admin: could not read the org's switches to show locked items; hiding them", {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  return lockedSwitchesIn(reach, org);
}

/**
 * {@link lockedSwitchesOf} over switches the caller has already read, for a
 * caller that needs the org's switches for something else too and so reads
 * them once (`GET /api/v1/admin/access`). `org` is `loadOrgSwitches()`'s
 * answer: `null` (no such org) or an unreadable read gives nothing.
 */
export function lockedSwitchesIn(
  reach: AdminReach,
  org: OrgSwitches | null
): readonly LockedAdminSwitch[] {
  const candidates = lockableSwitches(reach);
  if (candidates.length === 0 || !org || org.unreadable) return [];
  const on = new Set(org.on);
  return candidates
    .filter((s) => !on.has(s.key))
    .map((s) =>
      Object.freeze({
        requires: s.key,
        label: s.label,
        message: switchRequiredMessage(s.key),
        upgradeUrl: s.upgradeUrl,
      })
    );
}

/** The `whenLacking: 'lock'` switches a page requires that this reach does not meet for some tier it holds. */
function lockableSwitches(reach: AdminReach) {
  if (reach === 'platform' || reach.tiers.length === 0) return [];
  const required = new Set(adminPageRequirements().map((r) => r.requires));
  return registeredEntitlementSwitches().filter(
    (s) =>
      s.whenLacking === 'lock' &&
      required.has(s.key) &&
      reach.tiers.some((tier) => !reachesTier(reach, tier, s.key))
  );
}
