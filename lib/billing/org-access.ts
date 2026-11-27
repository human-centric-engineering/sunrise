/**
 * Who may start a checkout or open the billing portal for an org (§139
 * t-1094): its OWNER, acting in it, in a browser session.
 *
 * The authorization policy decides first, as its own resource kind
 * ({@link BILLING_RESOURCE_KIND}): the routes hand the guard
 * `{ kind: 'org.billing', id, orgId }`, which Sunrise's default policy admits
 * for the org's OWNER and ADMIN while they act in it (the ADMIN may view
 * billing, t-1095) and for a platform admin. A fork with a billing role of its
 * own answers that kind in its policy.
 *
 * Then {@link assertMayChangeBilling} narrows it, and no policy can widen it:
 *
 * - **The OWNER only.** Buying or cancelling commits the org to paying, so an
 *   ADMIN is refused, and so is a platform admin. Staff put an org on a plan
 *   by hand from `/admin/orgs/[id]` instead.
 * - **Acting in the org**, in a **browser session**, and **not a support
 *   session**: the vendor's staff do not buy for a customer.
 * - **Not the install org**, which is the vendor's own and is never billed.
 *
 * @see .context/billing/billing.md#who-may-do-what
 */

import { ConflictError, ForbiddenError } from '@/lib/api/errors';
import { isApiKeySession } from '@/lib/auth/api-keys';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { isSupportEntry } from '@/lib/auth/support-principal';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { getTenantContext } from '@/lib/tenancy/context';
import { resolveOrgResource } from '@/lib/tenancy/lifecycle';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

/** The resource kind the policy is asked about for an org's billing. */
export const BILLING_RESOURCE_KIND = 'org.billing';

/** The resource the billing routes hand the guard: the org the URL names. */
export async function resolveBillingResource(
  params: unknown
): Promise<{ kind: typeof BILLING_RESOURCE_KIND; id: string; orgId: string } | null> {
  const org = await resolveOrgResource(params);
  return org ? { kind: BILLING_RESOURCE_KIND, id: org.id, orgId: org.orgId } : null;
}

/** What {@link billingGuard} returns: `withAuth`'s `resource` and `ownership` options. */
export interface BillingGuard<TParams> {
  resource: (
    request: unknown,
    context?: { params: Promise<TParams> }
  ) => ReturnType<typeof resolveBillingResource>;
  ownership: { decidedBy: 'resource'; because: string };
}

/** `withAuth`'s `resource` and `ownership` options for a billing route. */
export function billingGuard<TParams>(because: string): BillingGuard<TParams> {
  return {
    resource: async (_request: unknown, context?: { params: Promise<TParams> }) =>
      resolveBillingResource(await context?.params),
    ownership: { decidedBy: 'resource' as const, because },
  };
}

/** Refuse anyone but the org's OWNER, acting in it, in their own browser session. */
export function assertMayChangeBilling(session: AuthenticatedSession, orgId: string): void {
  if (isApiKeySession(session)) {
    throw new ForbiddenError("Changing an organisation's billing requires a browser session");
  }
  if (isSupportEntry(getTenantContext())) {
    throw new ForbiddenError("Support staff cannot change an organisation's billing");
  }
  if (session.principal.orgId !== orgId) {
    throw new ForbiddenError('Switch to this organisation to change its billing');
  }
  if (orgId === INSTALL_ORG_ID) {
    throw new ConflictError('The install organisation is not billed', { reason: 'install_org' });
  }
  if (session.principal.orgRole !== ORG_OWNER_ROLE) {
    throw new ForbiddenError('Only an owner of this organisation can change its billing');
  }
}
