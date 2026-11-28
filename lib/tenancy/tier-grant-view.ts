/**
 * The grantable named tiers as a reader sees them (t-1123): each tier's
 * name, and the app's words for it in the viewer's language.
 *
 * What the Members page offers in its tier pickers, and what
 * `GET /api/v1/orgs/[id]/members` returns beside the roster, so the page
 * needs no second request. Labels and descriptions are the app's
 * `AdminText` (`registerAdminTier`'s `label` / `description`), resolved
 * through the catalogue as the access explainer resolves them; a tier with no
 * label is shown by its name in words (`page_designs` → "Page designs").
 *
 * Server-side: reads the request's locale through `next-intl/server`.
 */

import { getTranslations } from 'next-intl/server';
import { humanise, textResolver, type AccessTranslator } from '@/lib/auth/access-explainer';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { grantableAdminTiers } from '@/lib/tenancy/tier-grants';

/** One grantable tier, named for the reader. */
export interface GrantableTierView {
  name: string;
  label: string;
  description?: string;
}

/**
 * The tiers an org admin may grant in `orgId`, in registration order, named
 * in the request's language. Empty for the install org, whose memberships
 * take no grant, and for an app that registered no grantable tier.
 */
export async function grantableTiersFor(orgId: string): Promise<GrantableTierView[]> {
  if (orgId === INSTALL_ORG_ID) return [];
  const tiers = grantableAdminTiers();
  if (tiers.length === 0) return [];

  const t = await getTranslations();
  const translate: AccessTranslator = Object.assign(
    (key: string) => t(key as Parameters<typeof t>[0]),
    {
      has: (key: string) =>
        t.has(key as Parameters<typeof t>[0]) &&
        typeof t.raw(key as Parameters<typeof t>[0]) === 'string',
    }
  );
  const text = textResolver(translate);
  return tiers.map((tier) => ({
    name: tier.name,
    label: tier.label === undefined ? humanise(tier.name) : text(tier.label),
    ...(tier.description === undefined ? {} : { description: text(tier.description) }),
  }));
}
