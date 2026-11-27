/**
 * An org's billing, as its own admins see it (§139 t-1095)
 *
 * GET /api/v1/orgs/[id]/billing — the plan the org is on, the subscription's
 * state and current period, usage against each limit, the plans it could
 * buy, and whether this caller may buy one or open the portal
 * (`loadOrgBilling()`). What the console's billing page renders, in one call.
 *
 * Admission is the policy's, asked about the resource kind `org.billing`
 * (`lib/billing/org-access.ts`): Sunrise's policy admits the org's OWNER and
 * ADMIN while acting in it, and a platform admin. An ADMIN reads it; only the
 * OWNER may act on it, which `mayChange` reports and the checkout and portal
 * routes enforce. Refused: billing off (409 `billing_off`, as every billing
 * route answers), and an org that does not exist (404).
 */

import { withAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { BillingCheckoutError } from '@/lib/billing/checkout';
import { BILLING_OFF_MESSAGE, billingEnabled } from '@/lib/billing/config';
import { billingGuard } from '@/lib/billing/org-access';
import { loadOrgBilling } from '@/lib/billing/org-billing';
import { billingErrorResponse } from '@/lib/billing/route-errors';
import { orgIdParamSchema } from '@/lib/validations/tenancy';

const RESOURCE = billingGuard<{ id: string }>(
  'The policy admitted the caller to the billing of the org the URL names, and the handler reads that org’s billing only.'
);

export const GET = withAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  if (!billingEnabled()) {
    return billingErrorResponse(new BillingCheckoutError('BILLING_OFF', BILLING_OFF_MESSAGE));
  }
  const billing = await loadOrgBilling(id, session);
  if (!billing) {
    return billingErrorResponse(
      new BillingCheckoutError('ORG_NOT_FOUND', 'Organisation not found')
    );
  }
  return successResponse(billing);
}, RESOURCE);
