/**
 * Every org-tier admin page: core's roster, then the fork's (t-817), less the
 * core sections the fork closed (t-929) — and the fork's named tiers, with the
 * pages declared for them (t-999).
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
  registeredAppNamedTierAdminPages,
  registeredAppOrgTierAdminPages,
  registeredClosedCoreOrgTierSections,
  registeredNamedAdminTier,
  registeredNamedAdminTiers,
  restoreAppOrgTierAdminPages,
  restoreClosedCoreOrgTierSections,
  restoreNamedAdminTiers,
  withoutClosedSections,
  type ClosableCoreOrgTierSection,
  type NamedAdminTier,
  type NamedAdminTierDefinition,
  type NamedTierAdminPage,
} from '@/lib/auth/admin-tier';

const appInit = createAppInitGate({
  label: 'admin-tier: initAppOrgTierAdminPages',
  // With the init rolled back, every fork page is the platform's again, so an
  // org admin is refused it rather than let into half a list. A section it
  // had closed opens again with it: core's default, as the log says. A named
  // tier goes with its pages, so nobody holds it.
  subject: 'app org-tier admin pages, named tiers and closed core sections',
  init: initAppOrgTierAdminPages,
  // Every registry the init writes, so a throw rolls back all of them.
  snapshot: () => ({
    pages: registeredAppOrgTierAdminPages(),
    pageTiers: registeredAppNamedTierAdminPages(),
    tiers: registeredNamedAdminTiers(),
    closed: registeredClosedCoreOrgTierSections(),
  }),
  restore: ({ pages, pageTiers, tiers, closed }) => {
    restoreNamedAdminTiers(tiers);
    restoreAppOrgTierAdminPages(pages, pageTiers);
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
 * The fork's pages registered for a named tier (t-999), with their tiers. A
 * subset of {@link orgTierAdminPages}: an org admin opens these too. The layout
 * hands it to the gate and the sidebar beside that list, so they can tell
 * which tier a page is in (`adminPageTierOf()`).
 */
export function namedTierAdminPages(): readonly NamedTierAdminPage[] {
  appInit.ensure();
  return registeredAppNamedTierAdminPages();
}

/** The names of the fork's named tiers (t-999), in registration order: empty unless it registered one. */
export function namedAdminTiers(): readonly NamedAdminTier[] {
  appInit.ensure();
  return registeredNamedAdminTiers().map(([name]) => name);
}

/**
 * One named tier's definition, or `undefined` when the fork registered none of
 * that name. What the default policy asks before it admits anyone to a
 * surface declared for the tier; a name nobody registered admits nobody.
 */
export function namedAdminTier(name: string): Readonly<NamedAdminTierDefinition> | undefined {
  appInit.ensure();
  return registeredNamedAdminTier(name);
}

/**
 * How the fork's init went: `'ok'`, or `'failed'` when it threw and its pages
 * were rolled back. For the roster test, which must not pass a fork list that
 * is empty only because the init failed.
 */
export function appOrgTierAdminPagesInitState(): AppInitState {
  return appInit.ensure();
}

/** Test-only: clear the fork's pages, named tiers and closed sections, and re-arm the one-shot init. */
export function __resetAppOrgTierAdminPagesForTests(): void {
  restoreAppOrgTierAdminPages([]);
  restoreNamedAdminTiers([]);
  restoreClosedCoreOrgTierSections([]);
  appInit.reset();
  combined = null;
}
