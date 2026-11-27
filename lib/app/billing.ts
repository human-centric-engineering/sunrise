/**
 * App billing plans: names for sets of entitlements (§139 t-1093).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * A plan is your name for what an org has: the entitlement switches it
 * decides, on or off, its meter limits, and its AI budget, all registered in
 * `lib/app/entitlements.ts`. Platform staff assign an org a plan on
 * `/admin/orgs/[id]` (or `PATCH /api/v1/admin/orgs/[id]/plan`), and the
 * plan's values are written to the org. Payment is later and optional: a plan
 * given away or invoiced offline works with no provider configured.
 *
 * **Name every switch the plan decides, on or off.** A switch the plan does
 * not mention is left as it is, so naming only the ones that are on leaves a
 * switch that is on by default (`whenNothingSet: true`) on for every plan. The
 * same goes for limits: name a meter with `null` for "no limit" if the plan
 * decides that it has none.
 *
 * `setFallbackPlan()` names, once, the plan an org moves to when a paid
 * subscription ends. It must have no price.
 *
 * **A payment provider of your own** (§139 t-1094): Stripe ships in core
 * (`BILLING_PROVIDER=stripe`). For another, implement `BillingProvider`
 * (`lib/billing/provider.ts`), register it here with
 * `registerBillingProvider({ key, create, configured })`, and set
 * `BILLING_PROVIDER` to its key. `create()` runs on first use, so an SDK it
 * imports with `await import()` loads only then.
 *
 * Plans apply only at `TENANCY_MODE=multi`. Auto-wired:
 * `lib/billing/plans.ts` calls this once, lazily, before its first read.
 * Register inside this function, not at the module's top level, so a throw
 * rolls back: if it throws, or a plan names a switch or meter nothing
 * registers, no plan is registered and the server log says why.
 *
 * @example
 * ```ts
 * import { registerPlan, setFallbackPlan } from '@/lib/billing/plans';
 *
 * export function initAppBilling(): void {
 *   registerPlan({
 *     key: 'free',
 *     label: 'Free',
 *     switches: { reports: false, leads: true },
 *     meterLimits: { seats: 3, completed_conversations: 100 },
 *     aiBudgetUsd: 5,
 *     availableAtSignup: true, // a pricing page's "Start free" may link to it
 *   });
 *   registerPlan({
 *     key: 'pro',
 *     label: 'Pro',
 *     description: 'Reports, and room for a team.',
 *     switches: { reports: true, leads: true },
 *     meterLimits: { seats: 25, completed_conversations: null },
 *     aiBudgetUsd: 100,
 *     priceLookupKey: 'pro_monthly', // the price's lookup key at the provider
 *   });
 *   setFallbackPlan('free');
 * }
 * ```
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/billing/billing.md
 */
export function initAppBilling(): void {
  // No plans by default.
}
