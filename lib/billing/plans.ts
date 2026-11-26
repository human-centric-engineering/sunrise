/**
 * Billing plans: an app's names for sets of entitlements (§139 t-1093).
 *
 * An app could say what an org has (§135's switches, meter limits and §110's
 * AI budget) but had no name for a set of them, so staff set each one by hand
 * and a payment provider would have nothing to subscribe an org to. A plan is
 * that name. The app registers its plans from `lib/app/billing.ts`; staff
 * assign one (`lib/billing/subscriptions.ts`), and later a provider's webhook
 * does (t-1094). Either way `applyPlan()` writes what the plan decides.
 *
 * **A plan decides only what it names.** A switch, limit or budget it does
 * not mention is left as it is when it is applied, which is what lets a plan
 * leave staff's own settings alone, and why a plan must name a default-on
 * switch to turn it off.
 *
 * **Checked against the entitlement registry when the init runs.** A plan
 * naming a switch or meter nothing registers would write a value nothing
 * reads, and the typo would show only as an org lacking what it paid for. So
 * it throws, and the shared init gate rolls back every plan the init
 * registered (`platform.seam-design`). The fallback plan is checked the same
 * way: it must be a registered plan with no price, since an org moves to it
 * because it stopped paying.
 *
 * **Registration is synchronous and runs lazily** before the first read, in
 * whichever realm reads first (`platform.seam-realm`).
 *
 * @see lib/app/billing.ts — the fork's scaffold
 * @see lib/billing/apply-plan.ts — writing a plan to an org
 * @see .context/billing/billing.md#plans
 */

import { initAppBilling } from '@/lib/app/billing';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { registeredEntitlementSwitches } from '@/lib/tenancy/entitlements';
import { isMultiTenant } from '@/lib/tenancy/context';
import { allMeters } from '@/lib/tenancy/meters';
import {
  ENTITLEMENT_KEY_PATTERN,
  meterLimitSchema,
  orgQuotasSchema,
} from '@/lib/validations/tenancy';

/** A plan as an app registers it. */
export interface PlanDefinition {
  /**
   * What is stored on the org's subscription record: lower-case letters,
   * digits and underscores, starting with a letter. Never rename one orgs
   * hold, and never reuse a retired one; register a new key instead.
   */
  key: string;
  /** What staff, and later the org's owner, see. */
  label: string;
  /** One line saying what it gives. */
  description?: string;
  /**
   * Every switch the plan decides, by key: `true` on, `false` off. A switch
   * not named is left as it is when the plan is applied.
   */
  switches: Readonly<Record<string, boolean>>;
  /**
   * Meter limits the plan decides, by meter key (`seats` included): a whole
   * number, or `null` for no limit. A meter not named is left as it is.
   */
  meterLimits?: Readonly<Record<string, number | null>>;
  /**
   * The org's monthly AI budget in US dollars (§110's `monthlyBudgetUsd`), or
   * `null` for no cap of its own. Left out, the plan does not decide it.
   */
  aiBudgetUsd?: number | null;
  /**
   * The lookup key of the plan's price at the payment provider
   * (`pro_monthly`), set by the operator in both test and live mode. A plan
   * with none is assigned by hand or given away; it never goes through
   * checkout.
   */
  priceLookupKey?: string;
}

/** A registered plan, frozen, with its optional fields filled in. */
export interface RegisteredPlan {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly switches: Readonly<Record<string, boolean>>;
  readonly meterLimits: Readonly<Record<string, number | null>>;
  /** `undefined` when the plan does not decide the budget. */
  readonly aiBudgetUsd: number | null | undefined;
  readonly priceLookupKey: string | null;
}

/** The most plans an app may register. A sanity limit, not a design one. */
export const MAX_PLANS = 50;

/**
 * A price lookup key. Stripe allows up to 200 characters; the character set
 * is narrowed to what an operator types, so a stray space is caught here
 * rather than at checkout.
 */
const PRICE_LOOKUP_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

const plans = new Map<string, RegisteredPlan>();
let fallbackKey: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Register a plan. Call from `initAppBilling()` in `lib/app/billing.ts`.
 * Re-registering a key replaces it. A key that is not a key, a missing label,
 * a switch value that is not `true` or `false`, a limit or budget out of
 * range, a price lookup key another plan uses, or a plan past the
 * {@link MAX_PLANS}th throws, which rolls back every plan the init
 * registered. Whether the switches and meters it names exist is checked once
 * the init has run.
 */
export function registerPlan(definition: PlanDefinition): void {
  // Checked rather than trusted: an init written in JavaScript, or built from
  // config, can pass anything.
  if (typeof definition.key !== 'string' || !ENTITLEMENT_KEY_PATTERN.test(definition.key)) {
    throw new Error(
      `Plan key "${String(definition.key)}" must be lower-case letters, digits and underscores, starting with a letter, at most 48 characters`
    );
  }
  const key = definition.key;
  const label = typeof definition.label === 'string' ? definition.label.trim() : '';
  if (label.length === 0) throw new Error(`Plan "${key}" needs a label`);

  if (!isRecord(definition.switches)) {
    throw new Error(
      `Plan "${key}" needs switches: every switch it decides, each true or false ({} for none)`
    );
  }
  const switches: Record<string, boolean> = {};
  for (const [switchKey, value] of Object.entries(definition.switches)) {
    if (typeof value !== 'boolean') {
      // The string "false" is truthy: read loosely, it would grant the switch.
      throw new Error(
        `Plan "${key}" sets switch "${switchKey}" to ${JSON.stringify(value)}; it must be true or false`
      );
    }
    switches[switchKey] = value;
  }

  const rawLimits: unknown = definition.meterLimits ?? {};
  if (!isRecord(rawLimits)) throw new Error(`Plan "${key}" has meterLimits that is not an object`);
  const meterLimits: Record<string, number | null> = {};
  for (const [meterKey, value] of Object.entries(rawLimits)) {
    if (value !== null && !meterLimitSchema.safeParse(value).success) {
      throw new Error(
        `Plan "${key}" sets meter "${meterKey}" to ${JSON.stringify(value)}; it must be a whole number from 0 to 1,000,000,000, or null for no limit`
      );
    }
    meterLimits[meterKey] = value as number | null;
  }

  const budget: unknown = definition.aiBudgetUsd;
  if (
    budget !== undefined &&
    budget !== null &&
    !orgQuotasSchema.shape.monthlyBudgetUsd.safeParse(budget).success
  ) {
    throw new Error(
      `Plan "${key}" has aiBudgetUsd ${JSON.stringify(budget)}; it must be from 0 to 1,000,000 dollars, or null for no cap`
    );
  }

  const rawPrice: unknown = definition.priceLookupKey;
  if (
    rawPrice !== undefined &&
    (typeof rawPrice !== 'string' || !PRICE_LOOKUP_KEY_PATTERN.test(rawPrice))
  ) {
    throw new Error(
      `Plan "${key}" has priceLookupKey ${JSON.stringify(rawPrice)}; it must be the price's lookup key: letters, digits and _ . : -, at most 200 characters`
    );
  }
  const priceLookupKey = typeof rawPrice === 'string' ? rawPrice : null;
  if (priceLookupKey !== null) {
    // The provider names the plan by its price, so two plans on one price
    // would leave a paid subscription's plan undecidable.
    const clash = [...plans.values()].find(
      (p) => p.key !== key && p.priceLookupKey === priceLookupKey
    );
    if (clash) {
      throw new Error(
        `Plans "${clash.key}" and "${key}" both have priceLookupKey "${priceLookupKey}"; each price names one plan`
      );
    }
  }

  if (!plans.has(key) && plans.size >= MAX_PLANS) {
    throw new Error(`At most ${MAX_PLANS} plans can be registered; "${key}" is one too many`);
  }
  const description =
    typeof definition.description === 'string' ? definition.description.trim() : '';
  plans.set(
    key,
    Object.freeze({
      key,
      label,
      description,
      switches: Object.freeze(switches),
      meterLimits: Object.freeze(meterLimits),
      aiBudgetUsd: budget as number | null | undefined,
      priceLookupKey,
    })
  );
}

/**
 * Name the plan an org moves to when its paid subscription ends
 * (`.context/billing/billing.md#lapsed-subscriptions`). Call once, from
 * `initAppBilling()`; a later call replaces it. It must name a plan the init
 * registers, with no price, or the init fails. With none named, an org whose
 * subscription ends has every switch its plan decided turned off.
 */
export function setFallbackPlan(key: string): void {
  if (typeof key !== 'string' || !ENTITLEMENT_KEY_PATTERN.test(key)) {
    throw new Error(`Fallback plan "${String(key)}" is not a plan key`);
  }
  fallbackKey = key;
}

/**
 * Every switch and meter a plan names must be registered, and the fallback
 * must be a free plan. Run after the app's init, inside the gate, so a throw
 * rolls the plans back with everything else.
 */
function checkAgainstRegistries(): void {
  if (plans.size === 0 && fallbackKey === null) return;
  const switchKeys = new Set(registeredEntitlementSwitches().map((s) => s.key));
  const meterKeys = new Set(allMeters().map((m) => m.key));
  for (const plan of plans.values()) {
    const unknownSwitches = Object.keys(plan.switches).filter((k) => !switchKeys.has(k));
    if (unknownSwitches.length > 0) {
      throw new Error(
        `Plan "${plan.key}" names switches nothing registers: ${unknownSwitches.join(', ')}. Register them in lib/app/entitlements.ts, or check the spelling`
      );
    }
    const unknownMeters = Object.keys(plan.meterLimits).filter((k) => !meterKeys.has(k));
    if (unknownMeters.length > 0) {
      throw new Error(
        `Plan "${plan.key}" names meters nothing registers: ${unknownMeters.join(', ')}. Register them in lib/app/entitlements.ts, or check the spelling`
      );
    }
  }
  if (fallbackKey !== null) {
    const fallback = plans.get(fallbackKey);
    if (!fallback) throw new Error(`Fallback plan "${fallbackKey}" is not a registered plan`);
    if (fallback.priceLookupKey !== null) {
      throw new Error(
        `Fallback plan "${fallbackKey}" has a price; an org moves to it because it stopped paying, so it must have none`
      );
    }
  }
}

const appInit = createAppInitGate({
  label: 'billing: initAppBilling',
  // Half an app's plans registered would let staff assign some and not
  // others, and a lapsed org could fall back to a plan that is not there.
  subject: 'app billing plans',
  init: () => {
    initAppBilling();
    checkAgainstRegistries();
  },
  snapshot: () => ({ plans: new Map(plans), fallbackKey }),
  restore: (before) => {
    restoreMap(plans, before.plans);
    fallbackKey = before.fallbackKey;
  },
});

/** Every registered plan, in registration order. Empty on vanilla Sunrise. */
export function registeredPlans(): readonly RegisteredPlan[] {
  appInit.ensure();
  return [...plans.values()];
}

/** One plan by key, or `undefined` for a key no plan has. */
export function planOf(key: string): RegisteredPlan | undefined {
  appInit.ensure();
  return plans.get(key);
}

/** The app's fallback plan, or `null` when it names none. */
export function fallbackPlan(): RegisteredPlan | null {
  appInit.ensure();
  return fallbackKey === null ? null : (plans.get(fallbackKey) ?? null);
}

/**
 * Whether the app's `initAppBilling()` threw, or a plan failed its check, so
 * no plan is registered. A surface asks so it can say so, rather than look
 * like an install with no plans.
 */
export function billingPlansFailed(): boolean {
  return appInit.ensure() === 'failed';
}

/**
 * Whether plans apply on this install: `TENANCY_MODE=multi` and at least one
 * plan registered. No payment provider is needed, so a plan given away or
 * invoiced offline works on its own. Off, nothing here changes any org.
 */
export function billingPlansEnabled(): boolean {
  return isMultiTenant() && registeredPlans().length > 0;
}

/** Test-only: clear the registry and re-arm the one-shot app init. */
export function __resetBillingPlansForTests(): void {
  plans.clear();
  fallbackKey = null;
  appInit.reset();
}
