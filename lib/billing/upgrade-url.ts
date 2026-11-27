/**
 * The billing page as the default place to get a switch (§139 t-1095).
 *
 * An app may give a switch an `upgradeUrl` (`lib/tenancy/entitlements.ts`,
 * t-1053): the 403 for it carries the link, and a locked item and page show
 * it. When the app gives none and billing is on, the org-admin console's
 * billing page is offered instead, to a viewer who can open it: one the
 * policy admits to the org tier, the page's tier. A named-tier holder is
 * offered nothing, since the page is not theirs to open; nor is anyone in
 * the install org, which is never billed. The app's own link always wins.
 */

import { billingEnabled } from '@/lib/billing/config';
import { ORG_BILLING_PAGE_PATH } from '@/lib/billing/routes';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

// Re-exported where it has always been imported from; it lives in a module a
// client component can import (lib/billing/routes.ts).
export { ORG_BILLING_PAGE_PATH };

/** Who is asking, for {@link upgradeUrlFor}. */
export interface UpgradeViewer {
  /** The org the viewer acts in. */
  orgId: string | null | undefined;
  /** The policy admits the viewer to the org tier there, so the billing page opens for them. */
  holdsOrgTier: boolean;
}

/**
 * Where an org lacking a switch can get it: the app's link when it registered
 * one, else the billing page for a viewer who opens it in a billed org while
 * billing is on, else `null`.
 */
export function upgradeUrlFor(registered: string | null, viewer: UpgradeViewer): string | null {
  if (registered !== null) return registered;
  const billedOrg = Boolean(viewer.orgId) && viewer.orgId !== INSTALL_ORG_ID;
  return viewer.holdsOrgTier && billedOrg && billingEnabled() ? ORG_BILLING_PAGE_PATH : null;
}
