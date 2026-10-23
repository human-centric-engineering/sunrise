/**
 * Every org-tier admin page: core's roster, then the fork's (t-817), less the
 * core sections the fork closed (t-929).
 *
 * Core's list is the constant `ORG_TIER_ADMIN_PAGES`; the fork's comes from
 * `initAppOrgTierAdminPages()` in `lib/app/admin-tier.ts`, run once through the
 * shared init gate at the top of the first read here — all-or-nothing, so an
 * init that throws part-way opens none of its pages and closes none of core's
 * sections.
 *
 * **One narrowed answer.** The layout, the client gate, the sidebar and the
 * landing read {@link orgTierAdminPages}; the route guard reads
 * {@link closedCoreOrgTierSections}. Both come from the same registration, so a
 * closed section is closed on every surface or on none.
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
  registeredClosedCoreOrgTierSections,
  restoreAppOrgTierAdminPages,
  restoreClosedCoreOrgTierSections,
  withoutClosedSections,
  type ClosableCoreOrgTierSection,
} from '@/lib/auth/admin-tier';

const appInit = createAppInitGate({
  label: 'admin-tier: initAppOrgTierAdminPages',
  // With the init rolled back, every fork page is the platform's again, so an
  // org admin is refused it rather than let into half a list. A section it
  // had closed opens again with it: core's default, as the log says.
  subject: 'app org-tier admin pages and closed core sections',
  init: initAppOrgTierAdminPages,
  // Both registries the init writes, so a throw rolls back both.
  snapshot: () => ({
    pages: registeredAppOrgTierAdminPages(),
    closed: registeredClosedCoreOrgTierSections(),
  }),
  restore: ({ pages, closed }) => {
    restoreAppOrgTierAdminPages(pages);
    restoreClosedCoreOrgTierSections(closed);
  },
});

/** The combined list, and the registrations it was built from. */
let combined: {
  from: readonly string[];
  closed: readonly ClosableCoreOrgTierSection[];
  pages: readonly string[];
  /** Core's roster and the fork's with nothing closed, for {@link orgScopedAdminPages}. */
  scoped: readonly string[];
} | null = null;

/** The fork's org-tier page patterns: what `lib/app/admin-tier.ts` registered. */
export function getAppOrgTierAdminPages(): readonly string[] {
  appInit.ensure();
  return registeredAppOrgTierAdminPages();
}

/** The core sections the fork closed to org admins (t-929): empty unless it closed one. */
export function closedCoreOrgTierSections(): readonly ClosableCoreOrgTierSection[] {
  appInit.ensure();
  return registeredClosedCoreOrgTierSections();
}

/**
 * Every page an org admin may open on this install: core's roster less the
 * sections the fork closed, then the fork's. Built once and reused until the
 * fork's registrations change, because the layout reads it on every admin
 * request.
 */
export function orgTierAdminPages(): readonly string[] {
  return current().pages;
}

/** The cached lists, rebuilt when the fork's registrations change. */
function current(): NonNullable<typeof combined> {
  const app = getAppOrgTierAdminPages();
  const closed = registeredClosedCoreOrgTierSections();
  if (combined?.from !== app || combined.closed !== closed) {
    combined = {
      from: app,
      closed,
      pages: Object.freeze([...withoutClosedSections(ORG_TIER_ADMIN_PAGES, closed), ...app]),
      scoped: Object.freeze([...ORG_TIER_ADMIN_PAGES, ...app]),
    };
  }
  return combined;
}

/**
 * Every page that shows one org's rows, whether or not an org admin may open
 * it here: core's roster and the fork's, with nothing closed. For the header,
 * which names the acting org on those pages for a platform admin as well; a
 * section closed to org admins still shows a platform admin one org's rows.
 * Not an access answer — use {@link orgTierAdminPages} for that.
 */
export function orgScopedAdminPages(): readonly string[] {
  return current().scoped;
}

/**
 * How the fork's init went: `'ok'`, or `'failed'` when it threw and its pages
 * were rolled back. For the roster test, which must not pass a fork list that
 * is empty only because the init failed.
 */
export function appOrgTierAdminPagesInitState(): AppInitState {
  return appInit.ensure();
}

/** Test-only: clear the fork's pages and closed sections, and re-arm the one-shot init. */
export function __resetAppOrgTierAdminPagesForTests(): void {
  restoreAppOrgTierAdminPages([]);
  restoreClosedCoreOrgTierSections([]);
  appInit.reset();
  combined = null;
}
