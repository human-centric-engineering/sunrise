/**
 * Is this admitted admin the platform's, or an org tier's only? (§111 t-811)
 *
 * An org-tier route admits two kinds of caller: a platform admin, and an org
 * OWNER/ADMIN of the entered org. Almost every such route serves both the same,
 * because row isolation already bounds what it reads to the entered org. The
 * few that act beyond that org — a provider test whose vendor call runs as
 * the install org — must tell the two apart, and ask the policy rather than
 * the role so a fork's `canAdminister` answers the route as it answers the
 * admin layout.
 *
 * The question is the layout's platform question (`app/admin/layout.tsx`):
 * `canAdminister` with no resource and no tier, in the entered org.
 */
import { canAdminister, type AuthorizationPrincipal } from '@/lib/auth/authorization';

/** Does this principal administer the platform, not only an org-tier surface? */
export function administersPlatform(principal: AuthorizationPrincipal): Promise<boolean> {
  return canAdminister(principal, null, principal.orgId ? { org: principal.orgId } : {});
}
