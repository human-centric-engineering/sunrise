/**
 * Start a checkout for an org's plan (§139 t-1094)
 *
 * POST /api/v1/orgs/[id]/billing/checkout — `{ planKey }`: a hosted checkout
 * at the payment provider for that plan's price. Answers `{ url }`; the
 * browser goes there, and the provider sends it back to the org-admin
 * console's billing page. The org is put on the plan by the webhook, from the
 * subscription the provider holds, never by this route.
 *
 * Only the org's OWNER, acting in it, in a browser session, and never in a
 * support session or the install org (`lib/billing/org-access.ts`). Refused:
 * billing off (409 `billing_off`), a plan with no price (409
 * `not_purchasable`), a price not set up at the provider (409
 * `price_missing`), and an org that already has a live subscription (409
 * `already_subscribed`: change plan in the portal). Every checkout started is
 * audited (`org.billing.checkout`).
 */

import { withAuth } from '@/lib/auth/guards';
import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { BillingCheckoutError, startCheckout } from '@/lib/billing/checkout';
import { assertMayChangeBilling, billingGuard } from '@/lib/billing/org-access';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';
import { billingCheckoutInputSchema, orgIdParamSchema } from '@/lib/validations/tenancy';
import { billingErrorResponse } from '@/lib/billing/route-errors';

const RESOURCE = billingGuard<{ id: string }>(
  'The policy admitted the caller to the billing of the org the URL names, the handler narrows that to its owner acting in it, and it starts a checkout for that org only.'
);

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  assertMayChangeBilling(session, id);
  const { planKey } = await validateRequestBody(request, billingCheckoutInputSchema);

  let checkout: { url: string };
  try {
    checkout = await startCheckout(id, planKey);
  } catch (error) {
    if (error instanceof BillingCheckoutError) return billingErrorResponse(error);
    throw error;
  }

  logAdminAction({
    userId: session.user.id,
    action: 'org.billing.checkout',
    entityType: 'org',
    entityId: id,
    actingOrgId: id,
    metadata: { plan: planKey },
    clientIp: getClientIP(request),
  });
  log.info('Billing checkout started', { orgId: id, planKey, userId: session.user.id });
  return successResponse({ url: checkout.url });
}, RESOURCE);
