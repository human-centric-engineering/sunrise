/**
 * Every org-tier admin page: core's roster, then the fork's (t-817).
 *
 * Core's list is the constant `ORG_TIER_ADMIN_PAGES`; the fork's comes from
 * `initAppOrgTierAdminPages()` in `lib/app/admin-tier.ts`, run once through the
 * shared init gate at the top of the first read here — all-or-nothing, so an
 * init that throws part-way opens none of its pages.
 *
 * **Server only, by design.** The admin layout reads this on a full load and
 * hands the list to `<AdminTierGate>` and `<AdminHeader>` as a prop. Nothing in
 * the browser runs the fork's init: a list each realm built for itself could
 * differ (an init that reads a server-only env var, or throws in one realm),
 * and the layout would then admit an org admin the gate turns away, or the
 * reverse. One realm builds it, so there is one list.
 *
 * Kept apart from `lib/auth/admin-tier.ts` so that module imports nothing:
 * the scaffold imports the registrar from there, and `proxy.ts` its header
 * name, and neither should pull in the fork's scaffold through it.
 *
 * @see lib/auth/admin-tier.ts — the roster, the registrar and the matcher
 * @see lib/app/admin-tier.ts — the fork's pages
 */

import { createAppInitGate, type AppInitState } from '@/lib/fork-init';
import { initAppOrgTierAdminPages } from '@/lib/app/admin-tier';
import {
  ORG_TIER_ADMIN_PAGES,
  registeredAppOrgTierAdminPages,
  restoreAppOrgTierAdminPages,
} from '@/lib/auth/admin-tier';

const appInit = createAppInitGate({
  label: 'admin-tier: initAppOrgTierAdminPages',
  // Fail closed: with the init rolled back, every fork page is the platform's
  // again, so an org admin is refused it rather than let into half a list.
  subject: 'app org-tier admin pages',
  init: initAppOrgTierAdminPages,
  snapshot: registeredAppOrgTierAdminPages,
  restore: restoreAppOrgTierAdminPages,
});

/** The combined list, and the fork's list it was built from. */
let combined: { from: readonly string[]; pages: readonly string[] } | null = null;

/** The fork's org-tier page patterns: what `lib/app/admin-tier.ts` registered. */
export function getAppOrgTierAdminPages(): readonly string[] {
  appInit.ensure();
  return registeredAppOrgTierAdminPages();
}

/**
 * Every org-tier page pattern: core's roster, then the fork's. Built once and
 * reused until the fork's list changes, because the layout reads it on every
 * admin request.
 */
export function orgTierAdminPages(): readonly string[] {
  const app = getAppOrgTierAdminPages();
  if (combined?.from !== app) {
    combined = { from: app, pages: Object.freeze([...ORG_TIER_ADMIN_PAGES, ...app]) };
  }
  return combined.pages;
}

/**
 * How the fork's init went: `'ok'`, or `'failed'` when it threw and its pages
 * were rolled back. For the roster test, which must not pass a fork list that
 * is empty only because the init failed.
 */
export function appOrgTierAdminPagesInitState(): AppInitState {
  return appInit.ensure();
}

/** Test-only: clear the fork's pages and re-arm the one-shot init. */
export function __resetAppOrgTierAdminPagesForTests(): void {
  restoreAppOrgTierAdminPages([]);
  appInit.reset();
  combined = null;
}
