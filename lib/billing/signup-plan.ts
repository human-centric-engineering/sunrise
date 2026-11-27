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
 * **A free plan (no price) is part of the org's setup.** It is applied once
 * the setup is finished: the founder has joined, and no org-created hook this
 * process runs is still owed. So no later hook run can replace it with a
 * default of its own, and nothing the founder does is needed. The setup
 * applies it as it ends (`completeSignupOrg()`), and the maintenance tick's
 * `signupPlans` task applies any that setup could not, once the hooks it
 * waited on have run ({@link applyWaitingFreeSignupPlans}).
 *
 * **A paid plan is the next step of the signup.** The signup's own
 * continuation goes to checkout: the email form when it signs the person in,
 * the Google button's callback, and the verification link's callback, each to
 * `/admin/billing?signup=plan`, which asks
 * `POST /api/v1/orgs/[id]/billing/signup-plan` and goes to the checkout it
 * answers. Nothing intercepts later visits. The plan stays waiting until a
 * subscription starts (the webhook removes it) or the owner chooses not to
 * (`DELETE` on the same route), and while it waits the billing page offers
 * to continue to its checkout ({@link pendingSignupPlan}). So an owner who
 * leaves the checkout page, or whose checkout failed, finds it there.
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
import {
  billingPlansFailed,
  planOf,
  registeredPlans,
  type RegisteredPlan,
} from '@/lib/billing/plans';
import { SIGNUP_PLAN_PAGE } from '@/lib/billing/routes';
import { assignPlan, BillingPlanError, loadOrgSubscription } from '@/lib/billing/subscriptions';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { orgCreatedHookKeys } from '@/lib/tenancy/org-created-hooks';
import {
  isSettingsWriteConflict,
  ORG_AWAITING_FOUNDER_KEY,
  ORG_CREATED_HOOKS_KEY,
  ORG_SIGNUP_PLAN_KEY,
  readOrgCreatedOwed,
  readOrgSignupPlan,
  restoreOrgSignupPlan,
  takeOrgSignupPlan,
} from '@/lib/tenancy/org-settings';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
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

/**
 * Where the signup goes on to once the person is signed in, for the plan it
 * offered: the page that starts the paid plan's checkout, or `null` for the
 * usual landing route (a free plan, or none).
 */
export function signupContinuation(offer: SignupPlanOffer | null): string | null {
  return offer?.paid ? SIGNUP_PLAN_PAGE : null;
}

/**
 * {@link signupContinuation} for a signup the server sends a verification
 * link for, from the orgs the person owns: one waiting on a paid plan its
 * signup chose. So the link goes on to that plan's checkout however many
 * times it is resent, and on whichever device it is opened. (The user row's
 * signup record is cleared once the membership is written, before the first
 * email goes, so the membership is what is read.) Never throws: `null` on a
 * failed read.
 */
export async function signupContinuationForUser(userId: string): Promise<string | null> {
  try {
    if (!billingEnabled() || billingPlansFailed()) return null;
    // `OrgMembership` and `Org` are system models, so this read needs no
    // tenant scope. A person signing up owns one org, their own.
    const owned = await prisma.orgMembership.findMany({
      where: { userId, role: ORG_OWNER_ROLE },
      select: { org: { select: { settings: true } } },
      take: OWNED_ORGS_READ,
    });
    const paid = owned.some(({ org }) => {
      const waiting = readOrgSignupPlan(org.settings);
      const plan = waiting === null ? undefined : planOf(waiting);
      return plan !== undefined && plan.priceLookupKey !== null;
    });
    return paid ? SIGNUP_PLAN_PAGE : null;
  } catch (error) {
    logger.warn('billing: could not read the signup plan for a verification link', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** How many owned orgs {@link signupContinuationForUser} reads, at most. */
const OWNED_ORGS_READ = 10;

/** What the billing page offers of a paid plan still waiting from the signup. */
export interface PendingSignupPlan {
  key: string;
  label: string;
}

/**
 * The paid plan the org's signup chose that is still waiting, for the billing
 * page to offer, or `null`: none waiting, a free one (the setup's), one the
 * app no longer registers, or the org still awaiting its founder. The caller
 * shows it only while the org has no provider subscription.
 */
export function pendingSignupPlan(settings: unknown): PendingSignupPlan | null {
  if (hasKey(settings, ORG_AWAITING_FOUNDER_KEY)) return null;
  const waiting = readOrgSignupPlan(settings);
  if (waiting === null || billingPlansFailed()) return null;
  const plan = planOf(waiting);
  return plan && plan.priceLookupKey !== null ? { key: plan.key, label: plan.label } : null;
}

/** What {@link takeUpSignupPlan} did. */
export type SignupPlanTakeUp =
  /**
   * Nothing to do: nothing waiting, the org's setup not finished (a free
   * plan waits for it), or a plan dropped because the org already has a
   * provider subscription (there is nothing to tell the owner).
   */
  | { kind: 'none' }
  /** A free plan, applied. */
  | { kind: 'applied'; planKey: string }
  /** A paid plan: the checkout to send the owner to. It stays waiting. */
  | { kind: 'checkout'; planKey: string; url: string }
  /** It was waiting, and the app no longer registers it: dropped. */
  | { kind: 'dropped'; planKey: string };

/** How many times a write that clashed with another settings write is tried. */
const WRITE_ATTEMPTS = 3;

/**
 * Take up the plan the org's signup chose, for its owner on the billing page
 * (the route). A paid plan answers a checkout and **stays waiting**: the
 * owner may leave the checkout page, and the billing page then offers it
 * again; the webhook removes it once a subscription starts. A free plan is
 * applied as {@link applyFreeSignupPlan} would, once the org's setup is
 * finished. A plan the app no longer registers is dropped.
 *
 * A checkout that fails, refused by the provider (`BillingCheckoutError`) or
 * not, throws for the route to answer; the plan stays waiting, and the owner
 * can try again from the billing page. Nothing is taken while the app's
 * billing init failed, since no plan is registered then and a valid choice
 * would look retired.
 *
 * Who may call it is the caller's business: the route asks for the org's
 * OWNER acting in it.
 */
export async function takeUpSignupPlan(
  orgId: string,
  options: { actorUserId: string | null }
): Promise<SignupPlanTakeUp> {
  const waiting = await waitingPlan(orgId);
  if (waiting === null) return { kind: 'none' };
  const { planKey, settings } = waiting;

  const plan = planOf(planKey);
  if (!plan) {
    if ((await take(orgId, (key) => key === planKey)) === null) return { kind: 'none' };
    logger.warn('billing: the plan chosen at signup is no longer registered; dropped', {
      orgId,
      planKey,
    });
    return { kind: 'dropped', planKey };
  }
  if (plan.priceLookupKey === null) return applyFree(orgId, plan, settings, options.actorUserId);

  // Already subscribed (on any plan): the choice is settled, so it goes, and
  // no second checkout is started over the subscription.
  if ((await loadOrgSubscription(orgId))?.providerManaged) {
    await take(orgId, (key) => key === plan.key);
    return { kind: 'none' };
  }
  const { url } = await startCheckout(orgId, plan.key);
  logger.info('billing: started checkout for the plan chosen at signup', {
    orgId,
    planKey: plan.key,
  });
  return { kind: 'checkout', planKey: plan.key, url };
}

/**
 * Remove the plan the org's signup chose, when its owner chooses not to take
 * it up (the route's `DELETE`).
 *
 * @returns the key removed, or `null` when none was waiting.
 */
export async function dismissSignupPlan(orgId: string): Promise<string | null> {
  return take(orgId, () => true);
}

/**
 * Apply the free plan the org's signup chose, once its setup is finished:
 * from the setup itself as it ends, and from the maintenance sweep. Never
 * throws: a failure is logged, and the plan stays waiting for the sweep. A
 * paid plan is left alone; it is the owner's to start.
 *
 * @returns whether it applied one.
 */
export async function applyFreeSignupPlan(
  orgId: string,
  founderUserId: string | null
): Promise<boolean> {
  try {
    const waiting = await waitingPlan(orgId);
    if (waiting === null) return false;
    const plan = planOf(waiting.planKey);
    if (!plan || plan.priceLookupKey !== null) return false;
    return (await applyFree(orgId, plan, waiting.settings, founderUserId)).kind === 'applied';
  } catch (error) {
    logger.error('billing: could not apply the plan chosen at signup', error, { orgId });
    return false;
  }
}

/** How many orgs one sweep applies a free signup plan to, at most. */
const SWEEP_BATCH = 50;

/** What one {@link applyWaitingFreeSignupPlans} sweep did. */
export interface SignupPlanSweepResult {
  /** Orgs it looked at: each had a free signup plan waiting. */
  orgs: number;
  /** Of those, the ones whose plan it applied. */
  applied: number;
}

/**
 * The maintenance sweep (`signupPlans`): apply the free signup plans whose
 * org's setup has finished since, or whose application failed. Only orgs
 * that are `ACTIVE`, not awaiting their founder, waiting on a registered free
 * plan and owing no hook this process runs are read, so an org waiting on a
 * hook is not re-read every tick. With billing off, or no free plan
 * registered, it makes no query.
 */
export async function applyWaitingFreeSignupPlans(): Promise<SignupPlanSweepResult> {
  if (!billingEnabled() || billingPlansFailed()) return { orgs: 0, applied: 0 };
  const freeKeys = registeredPlans()
    .filter((plan) => plan.priceLookupKey === null)
    .map((plan) => plan.key);
  if (freeKeys.length === 0) return { orgs: 0, applied: 0 };
  const hookKeys = orgCreatedHookKeys();
  // `Org` is a system model, so this read needs no tenant scope.
  // Owing a hook this process runs means the setup is not finished; with
  // none registered, `?|` over an empty array is false for every org.
  const waiting = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM org
     WHERE status = 'ACTIVE'
       AND settings->>${ORG_SIGNUP_PLAN_KEY} = ANY(${freeKeys}::text[])
       AND NOT settings ? ${ORG_AWAITING_FOUNDER_KEY}
       AND NOT COALESCE(settings->${ORG_CREATED_HOOKS_KEY}->'owed' ?| ${hookKeys}::text[], false)
     LIMIT ${SWEEP_BATCH}`;
  let applied = 0;
  for (const { id } of waiting) if (await applyFreeSignupPlan(id, null)) applied += 1;
  return { orgs: waiting.length, applied };
}

/** The org's waiting signup plan, when one may be taken up now; `null` otherwise. */
async function waitingPlan(orgId: string): Promise<{ planKey: string; settings: unknown } | null> {
  // `Org` is a system model, so this read needs no tenant scope.
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  const planKey = org ? readOrgSignupPlan(org.settings) : null;
  if (planKey === null || hasKey(org?.settings, ORG_AWAITING_FOUNDER_KEY)) return null;
  // Billing switched off since the signup, or its plans failed to register:
  // left waiting, for either may come back.
  if (!billingEnabled() || billingPlansFailed()) return null;
  return { planKey, settings: org?.settings };
}

/**
 * Apply a free signup plan, once the org's setup is finished. Removed first
 * (a serializable take, so of two callers only one applies it), then applied;
 * an assignment that fails changes nothing and the plan is put back. One the
 * org can no longer take (the provider manages its plan) is dropped.
 */
async function applyFree(
  orgId: string,
  plan: RegisteredPlan,
  settings: unknown,
  actorUserId: string | null
): Promise<SignupPlanTakeUp> {
  if (setupOwesHooks(settings)) return { kind: 'none' };
  if ((await take(orgId, (key) => key === plan.key)) === null) return { kind: 'none' };
  let assigned: Awaited<ReturnType<typeof assignPlan>>;
  try {
    assigned = await assignPlan(orgId, plan.key);
  } catch (error) {
    if (error instanceof BillingPlanError && error.code === 'PROVIDER_MANAGED') {
      logger.info('billing: the org has a subscription; the free plan chosen at signup dropped', {
        orgId,
        planKey: plan.key,
      });
      return { kind: 'none' };
    }
    await putBack(orgId, plan.key);
    throw error;
  }
  if (assigned.changed) {
    logAdminAction({
      // The founder chose it at signup; `null` when the sweep applies it.
      userId: actorUserId,
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

/**
 * Whether the org still owes an org-created hook this process runs, so its
 * setup is not finished. A record this version cannot read counts as owed: a
 * newer version wrote it and runs its hooks. A key no process registers any
 * more does not hold the plan back.
 */
function setupOwesHooks(settings: unknown): boolean {
  if (!isRecord(settings) || !(ORG_CREATED_HOOKS_KEY in settings)) return false;
  const raw = settings[ORG_CREATED_HOOKS_KEY];
  if (isRecord(raw) && Array.isArray(raw.owed) && raw.owed.length === 0) return false;
  const owed = readOrgCreatedOwed(settings);
  if (owed === null) return true;
  const registered = new Set(orgCreatedHookKeys());
  return owed.owed.some((key) => registered.has(key));
}

/** {@link takeOrgSignupPlan}, tried again when it clashes with another settings write. */
async function take(orgId: string, accept: (planKey: string) => boolean): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await takeOrgSignupPlan(orgId, accept);
    } catch (error) {
      if (!isSettingsWriteConflict(error) || attempt >= WRITE_ATTEMPTS) throw error;
    }
  }
}

/**
 * Put back a free plan whose assignment failed and changed nothing, tried
 * again on a clash as {@link take} is. Never throws: a failure is logged at
 * `error`, the plan then lost.
 */
async function putBack(orgId: string, planKey: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await restoreOrgSignupPlan(orgId, planKey);
      return;
    } catch (error) {
      if (isSettingsWriteConflict(error) && attempt < WRITE_ATTEMPTS) continue;
      logger.error('billing: could not put back the plan chosen at signup', error, {
        orgId,
        planKey,
      });
      return;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKey(settings: unknown, key: string): boolean {
  return isRecord(settings) && key in settings;
}
