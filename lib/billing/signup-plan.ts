/**
 * A plan chosen at signup (§139 t-1096).
 *
 * A pricing page links to signup with the plan in the query
 * (`/signup?plan=pro`). The choice is carried through the signup itself (the
 * email form's body, or the OAuth state for a Google signup), checked against
 * the registered plans in the user-create hook, and written on the org the
 * signup founds (`Org.settings.signupPlan`, `ORG_SIGNUP_PLAN_KEY`). So it
 * survives email verification, a second device and a day's delay: it belongs
 * to the org, not to a browser.
 *
 * **Taken up once the founder can act there.** A free plan (one with no
 * price) is applied when the org's setup runs (`completeSignupOrg()`), after
 * the app's org-created hooks, so the plan the person chose is what the org
 * ends up on. A paid one waits for the founder's first visit to the landing
 * route: the proxy sends them to the billing page, which asks
 * `POST /api/v1/orgs/[id]/billing/signup-plan` to take it up and goes to the
 * checkout it answers. Taking it up removes it, so it happens once; an owner
 * who leaves the checkout page has the billing page's own buttons.
 *
 * **Nothing changes unless all of these hold:** billing is on
 * (`billingEnabled()`), the key names a registered plan, and the signup gets
 * an org of its own (`asksSignupOrg()`, answered `own`). An unknown plan is
 * dropped, never trusted; an invited signup, one an app's resolver sends to an
 * existing org or the install org, and platform staff ignore it.
 *
 * @see .context/billing/billing.md#choosing-a-plan-at-signup
 */

import { z } from 'zod';

import { billingEnabled } from '@/lib/billing/config';
import { startCheckout } from '@/lib/billing/checkout';
import { planOf, type RegisteredPlan } from '@/lib/billing/plans';
import { assignPlan } from '@/lib/billing/subscriptions';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  isSettingsWriteConflict,
  ORG_AWAITING_FOUNDER_KEY,
  readOrgSignupPlan,
  takeOrgSignupPlan,
} from '@/lib/tenancy/org-settings';
import { ENTITLEMENT_KEY_PATTERN } from '@/lib/validations/tenancy';

/** The signup link's query parameter: `/signup?plan=pro`. */
export const SIGNUP_PLAN_PARAM = 'plan';

/** A plan key's shape. Whether it names a plan is {@link signupPlanOf}'s question. */
const planKeySchema = z.string().regex(ENTITLEMENT_KEY_PATTERN);

/**
 * The registered plan a signup link names, or `null`: billing off, nothing
 * carried, not a key, or a key no plan has. Takes anything, since it reads
 * a query string, a request body and the OAuth state.
 */
export function signupPlanOf(raw: unknown): RegisteredPlan | null {
  const parsed = planKeySchema.safeParse(raw);
  if (!parsed.success) return null;
  if (!billingEnabled()) return null;
  return planOf(parsed.data) ?? null;
}

/** What the signup page shows of the plan a link names. */
export interface SignupPlanOffer {
  key: string;
  label: string;
  /** It has a price, so checkout follows signup. */
  paid: boolean;
}

/** {@link signupPlanOf} for the signup page, or `null` to show nothing. */
export function signupPlanOffer(raw: unknown): SignupPlanOffer | null {
  const plan = signupPlanOf(raw);
  return plan ? { key: plan.key, label: plan.label, paid: plan.priceLookupKey !== null } : null;
}

/** What {@link takeUpSignupPlan} did. */
export type SignupPlanTakeUp =
  /** Nothing was waiting, or it is not this caller's to take. */
  | { kind: 'none' }
  /** A free plan, applied. */
  | { kind: 'applied'; planKey: string }
  /** A paid plan: the checkout to send the owner to. */
  | { kind: 'checkout'; planKey: string; url: string }
  /** It was waiting, and the app no longer registers it: dropped. */
  | { kind: 'dropped'; planKey: string };

/** How many times a take that clashed with another settings write is tried. */
const TAKE_ATTEMPTS = 3;

/**
 * Take up the plan the org's signup chose, if one is waiting. With `paid:
 * false` (the org's setup) only a free plan is taken; a paid one is left for
 * the founder's first visit. With `paid: true` (the owner, on the billing
 * page) either is: a free one is applied, a paid one gets a checkout.
 *
 * **Once each.** A free plan is applied, then removed: applying is
 * idempotent, so two callers at once both apply the same plan, and one that
 * fails part-way leaves it waiting for the next. A paid one is removed first,
 * then sent to checkout, so the owner is sent there once. A checkout that is
 * then refused (its price not set up at the provider, say) throws
 * `BillingCheckoutError` for the route to answer, and the owner chooses on
 * the billing page as anyone would.
 *
 * Who may call it is the caller's business: the route asks for the org's
 * OWNER acting in it.
 */
export async function takeUpSignupPlan(
  orgId: string,
  options: { paid: boolean; actorUserId: string | null }
): Promise<SignupPlanTakeUp> {
  // `Org` is a system model, so this read needs no tenant scope.
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  const waiting = org ? readOrgSignupPlan(org.settings) : null;
  if (waiting === null || isAwaitingFounder(org?.settings)) return { kind: 'none' };

  // Billing switched off since the signup: left waiting, for it may come back.
  if (!billingEnabled()) return { kind: 'none' };
  const plan = planOf(waiting);
  if (!plan) {
    if ((await take(orgId, (key) => key === waiting)) === null) return { kind: 'none' };
    logger.warn('billing: the plan chosen at signup is no longer registered; dropped', {
      orgId,
      planKey: waiting,
    });
    return { kind: 'dropped', planKey: waiting };
  }

  if (plan.priceLookupKey === null) {
    const assigned = await assignPlan(orgId, plan.key);
    await take(orgId, (key) => key === plan.key);
    if (assigned.changed) {
      logAdminAction({
        // The founder chose it at signup.
        userId: options.actorUserId,
        action: 'org.plan.assign',
        entityType: 'org',
        entityId: orgId,
        actingOrgId: orgId,
        changes: { plan: { from: assigned.previousPlanKey, to: plan.key } },
        metadata: { source: 'signup' },
      });
    }
    logger.info('billing: applied the plan chosen at signup', { orgId, planKey: plan.key });
    return { kind: 'applied', planKey: plan.key };
  }

  if (!options.paid) return { kind: 'none' };
  if ((await take(orgId, (key) => key === plan.key)) === null) return { kind: 'none' };
  const { url } = await startCheckout(orgId, plan.key);
  logger.info('billing: started checkout for the plan chosen at signup', {
    orgId,
    planKey: plan.key,
  });
  return { kind: 'checkout', planKey: plan.key, url };
}

/** {@link takeOrgSignupPlan}, tried again when it clashes with another settings write. */
async function take(orgId: string, accept: (planKey: string) => boolean): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await takeOrgSignupPlan(orgId, accept);
    } catch (error) {
      if (!isSettingsWriteConflict(error) || attempt >= TAKE_ATTEMPTS) throw error;
    }
  }
}

function isAwaitingFounder(settings: unknown): boolean {
  return (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    ORG_AWAITING_FOUNDER_KEY in settings
  );
}

/**
 * {@link takeUpSignupPlan} for a free plan, from the org's setup. Never
 * throws: a failure is logged, and the plan stays waiting for the founder's
 * first visit, which takes it up then.
 */
export async function applyFreeSignupPlan(orgId: string, founderUserId: string): Promise<void> {
  try {
    await takeUpSignupPlan(orgId, { paid: false, actorUserId: founderUserId });
  } catch (error) {
    logger.error('billing: could not apply the plan chosen at signup', error, { orgId });
  }
}
