/**
 * Take up the plan an org's signup chose (§139 t-1096)
 *
 * POST /api/v1/orgs/[id]/billing/signup-plan — no body. When the org's signup
 * link named a plan that has not been taken up yet, takes it up: a paid plan
 * answers `{ outcome: 'checkout', planKey, url }`, and the browser goes to
 * that checkout; a free one is applied, `{ outcome: 'applied', planKey }`.
 * Otherwise `{ outcome: 'none' }` (nothing waiting, or already taken up), or
 * `{ outcome: 'dropped', planKey }` when the app no longer registers it. It is
 * taken up once: a second call answers `none`.
 *
 * The billing page calls it when the proxy sends the founder there
 * (`/admin/billing?signup=plan`) on their first visit to the landing route.
 *
 * Only the org's OWNER, acting in it, in a browser session, as for a checkout
 * (`lib/billing/org-access.ts`). Refused: billing off (409 `billing_off`), and
 * a checkout the provider refuses (409 `price_missing`, as the checkout
 * route). A checkout started is audited (`org.billing.checkout`, with
 * `source: 'signup'`), a plan applied as `org.plan.assign`.
 */

import { withAuth } from '@/lib/auth/guards';
import { getRouteLogger } from '@/lib/api/context';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { BillingCheckoutError } from '@/lib/billing/checkout';
import { billingEnabled, BILLING_OFF_MESSAGE } from '@/lib/billing/config';
import { assertMayChangeBilling, billingGuard } from '@/lib/billing/org-access';
import { billingErrorResponse } from '@/lib/billing/route-errors';
import { takeUpSignupPlan } from '@/lib/billing/signup-plan';
import { BillingPlanError } from '@/lib/billing/subscriptions';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';
import { orgIdParamSchema } from '@/lib/validations/tenancy';

const RESOURCE = billingGuard<{ id: string }>(
  'The policy admitted the caller to the billing of the org the URL names, the handler narrows that to its owner acting in it, and it takes up that org’s own signup plan only.'
);

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  assertMayChangeBilling(session, id);
  if (!billingEnabled()) {
    return billingErrorResponse(new BillingCheckoutError('BILLING_OFF', BILLING_OFF_MESSAGE));
  }

  let result: Awaited<ReturnType<typeof takeUpSignupPlan>>;
  try {
    result = await takeUpSignupPlan(id, { paid: true, actorUserId: session.user.id });
  } catch (error) {
    if (error instanceof BillingCheckoutError) return billingErrorResponse(error);
    if (error instanceof BillingPlanError) {
      return errorResponse(error.message, {
        code: error.code === 'ORG_NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT',
        status: error.code === 'ORG_NOT_FOUND' ? 404 : 409,
        details: { reason: error.code.toLowerCase() },
      });
    }
    throw error;
  }

  if (result.kind === 'checkout') {
    logAdminAction({
      userId: session.user.id,
      action: 'org.billing.checkout',
      entityType: 'org',
      entityId: id,
      actingOrgId: id,
      metadata: { planKey: result.planKey, source: 'signup' },
      clientIp: getClientIP(request),
    });
    log.info('Billing checkout started for the signup plan', {
      orgId: id,
      planKey: result.planKey,
      userId: session.user.id,
    });
    return successResponse({ outcome: 'checkout', planKey: result.planKey, url: result.url });
  }
  if (result.kind === 'none') return successResponse({ outcome: 'none' });
  return successResponse({ outcome: result.kind, planKey: result.planKey });
}, RESOURCE);
