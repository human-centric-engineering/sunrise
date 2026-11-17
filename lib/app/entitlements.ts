/**
 * App entitlement switches: what an org can have (§135 t-1033).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * A switch is something an org either has or does not: a package it bought,
 * an area it may use, a free tier. Register yours here, and platform staff
 * set them on each org from `/admin/orgs/[id]` (or
 * `PATCH /api/v1/admin/orgs/[id]/entitlements`). Read an org's with
 * `orgHasSwitch()` or `loadOrgSwitches()` from `lib/tenancy/entitlements.ts`.
 *
 * A switch is on or off; it carries no value. If you sell plans, a plan is a
 * set of switches, so the code that checks a switch never changes when the
 * plans do.
 *
 * `whenNothingSet` is what an org nobody has set anything on gets. Leave it
 * off (the default) for an area that is new, so it opens only where someone
 * switches it on; turn it on for an area every org already uses, so no org
 * that exists today loses it.
 *
 * Auto-wired: `lib/tenancy/entitlements.ts` calls this once, lazily, before
 * its first read. Register inside this function, not at the module's top
 * level, so a throw rolls back. If it throws, no switch is registered: the
 * registry rolls back and logs why, and every org reads as having none of
 * yours.
 *
 * @example
 * ```ts
 * import { registerEntitlementSwitch } from '@/lib/tenancy/entitlements';
 *
 * export function initAppEntitlements(): void {
 *   registerEntitlementSwitch({
 *     key: 'reports',
 *     label: 'Reports',
 *     description: 'Build and share reports from collected answers.',
 *   });
 *   registerEntitlementSwitch({
 *     key: 'leads',
 *     label: 'Lead generation',
 *     description: 'Funnels, leads and lead briefs.',
 *     whenNothingSet: true, // every org already has this today
 *   });
 * }
 * ```
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/tenancy/entitlements.md
 */
export function initAppEntitlements(): void {
  // No app entitlement switches by default.
}
