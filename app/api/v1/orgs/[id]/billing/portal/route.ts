/**
 * Open the billing portal for an org (§139 t-1094)
 *
 * POST /api/v1/orgs/[id]/billing/portal — answers `{ url }`: the payment
 * provider's own page, where the org's owner changes plan or card, sees
 * invoices, or cancels. The provider sends the browser back to the org-admin
 * console's billing page, and any change reaches the org by the webhook.
 *
 * Who may call it is the same as checkout (`lib/billing/org-access.ts`): the
 * org's OWNER, acting in it. Refused: billing off (409 `billing_off`), and an
 * org that has never been through a checkout (409 `no_customer`).
 */

import { withAuth } from '@/lib/auth/guards';
import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { BillingCheckoutError, openBillingPortal } from '@/lib/billing/checkout';
import { assertMayChangeBilling, billingGuard } from '@/lib/billing/org-access';
import { billingErrorResponse } from '@/lib/billing/route-errors';
import { orgIdParamSchema } from '@/lib/validations/tenancy';

const RESOURCE = billingGuard<{ id: string }>(
  'The policy admitted the caller to the billing of the org the URL names, the handler narrows that to its owner acting in it, and it opens that org’s portal only.'
);

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  assertMayChangeBilling(session, id);

  let portal: { url: string };
  try {
    portal = await openBillingPortal(id);
  } catch (error) {
    if (error instanceof BillingCheckoutError) return billingErrorResponse(error);
    throw error;
  }
  log.info('Billing portal opened', { orgId: id, userId: session.user.id });
  return successResponse({ url: portal.url });
}, RESOURCE);
