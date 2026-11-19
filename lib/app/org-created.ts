/**
 * App org-creation hook registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `createOrg()` (`lib/tenancy/lifecycle.ts`) calls this once,
 * lazily, before it first creates an org. Add
 * `registerOrgCreatedHook(key, hook)` calls to set up every new org, however it
 * was made (Sunrise's admin, or your own call to `createOrg()`): grant it an AI
 * provider, record how it is served, set its starting entitlement switches.
 *
 *   import { registerOrgCreatedHook } from '@/lib/tenancy/org-created-hooks';
 *   import { setOrgSwitches } from '@/lib/tenancy/entitlements';
 *   import { loadOrgEntitlements } from '@/lib/tenancy/org-settings';
 *
 *   export function initAppOrgCreatedHooks(): void {
 *     // A retry must not undo switches staff have set since: fill only an
 *     // empty set.
 *     registerOrgCreatedHook('app:starting-package', async ({ orgId }) => {
 *       const current = await loadOrgEntitlements(orgId);
 *       if (!current || current.unreadable) throw new Error('switches unreadable');
 *       if (current.on.length + current.off.length > 0) return;
 *       await setOrgSwitches(orgId, { on: ['free-tier'], off: [] });
 *     });
 *   }
 *
 * The hook receives `{ orgId, slug, name, source, ownerUserId, retry, signal }`
 * and runs inside the new org's tenant scope. Hooks run one at a time, in the
 * order registered, each for at most 10 seconds before it is left owed and
 * `signal` aborts.
 *
 * Runs AFTER the org exists, so a hook **cannot refuse an org**. A throw is
 * logged, the hook stays owed, and the maintenance tick retries it until it
 * succeeds, so **write every hook to be idempotent**: it can run more than once
 * for one org. Only orgs created after a hook is registered are owed it.
 * Empty registry = today's behaviour, byte-for-byte.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/tenancy/identity.md
 */
export function initAppOrgCreatedHooks(): void {
  // No app org-created hooks by default.
}
