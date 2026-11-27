/**
 * The billing page as the default place to get a switch (§139 t-1095).
 *
 * An app may give a switch an `upgradeUrl` (`lib/tenancy/entitlements.ts`,
 * t-1053): the 403 for it carries the link, and a locked item and page show
 * it. When the app gives none and billing is on, the org-admin console's
 * billing page is offered instead, to a viewer who can open it: the org's
 * OWNER or ADMIN. A named-tier holder is offered nothing, since the page is
 * not theirs to open. The app's own link always wins.
 */

import { billingEnabled } from '@/lib/billing/config';

/** The org-admin console's billing page, where the provider also sends an owner back to. */
export const ORG_BILLING_PAGE_PATH = '/admin/billing';

/**
 * Where an org lacking a switch can get it: the app's link when it registered
 * one, else the billing page for a viewer who opens it while billing is on,
 * else `null`.
 */
export function upgradeUrlFor(
  registered: string | null,
  viewerOpensBilling: boolean
): string | null {
  if (registered !== null) return registered;
  return viewerOpensBilling && billingEnabled() ? ORG_BILLING_PAGE_PATH : null;
}
