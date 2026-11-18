/**
 * Where `/admin` sends each viewer (t-928).
 *
 * A platform admin lands on the overview, which is install-wide and theirs
 * alone. An org OWNER/ADMIN lands on the orchestration dashboard, unless the
 * fork names another page in `lib/app/admin-landing.ts` — or on Members, when
 * the fork closed orchestration to org admins (t-929) and named nowhere else.
 *
 * The fork's page is used only if an org admin may open it: a path under
 * `/admin/` with literal segments, listed word for word on the org-tier roster
 * (core's or the fork's) — not a concrete URL of an `[x]` page, which is one
 * row of one org. Anything else would turn them away the moment they arrived — to the
 * sign-in landing, and back here if that is `/admin`. So a page that fails is
 * not used: `/admin` logs why and falls back to the platform default, and the
 * roster test fails on the same check, so the fork hears of it in CI first.
 *
 * Someone who holds a fork's named tiers and is not an org admin (t-999)
 * lands on the `landing` their first tier names ({@link heldTierLanding}),
 * held to the same rule against that tier's own pages.
 *
 * A landing that requires an entitlement switch (§135 t-1034) is used only
 * for a viewer whose org has it, by the reach the layout already asked the
 * policy for ({@link SwitchMet}). For anyone else it is passed over, without
 * a log line, since a landing some orgs cannot open is not a mistake: an org
 * admin goes to the platform default, and a tier holder to the tier's next
 * page they can open.
 *
 * Server only: it reads the roster through `orgTierAdminPages()`, which runs
 * the fork's page init.
 *
 * @see lib/app/admin-landing.ts — the fork's choice
 * @see app/admin/page.tsx — the one caller
 */
import { logger } from '@/lib/logging';
import { appOrgAdminLandingRoute } from '@/lib/app/admin-landing';
import {
  adminPageRequirements,
  namedAdminTier,
  namedAdminTiers,
  namedTierAdminPages,
  orgTierAdminPages,
} from '@/lib/auth/org-tier-admin-pages';
import {
  adminPageTierOf,
  isPlainAdminPath,
  type DeclaredAdminTier,
  type NamedTierAdminPage,
} from '@/lib/auth/admin-tier';

/**
 * Whether this viewer's org meets `requires` on a page of `tier`: in
 * practice `reachesTier(reach, tier, requires)` (t-1034). The default, for a
 * caller with no viewer to ask, meets none, so a landing that requires a
 * switch is passed over rather than risked.
 */
export type SwitchMet = (tier: DeclaredAdminTier, requires: string) => boolean;

const NO_SWITCH_MET: SwitchMet = () => false;

/**
 * A test of whether this viewer may land on a page of `tier`, as far as
 * switches go. The requirements are read once, and looked up by pattern
 * exactly: a landing is a plain path listed word for word, so no pattern
 * matching is needed.
 */
function switchAllows(met: SwitchMet): (route: string, tier: DeclaredAdminTier) => boolean {
  const required = new Map(adminPageRequirements().map((r) => [r.pattern, r.requires]));
  return (route, tier) => {
    const requires = required.get(route);
    return requires === undefined || met(tier, requires);
  };
}

/** Where a platform admin lands. */
export const PLATFORM_ADMIN_LANDING = '/admin/overview';

/** Where an org admin lands when the fork names nowhere else. */
export const DEFAULT_ORG_ADMIN_LANDING = '/admin/orchestration';

/**
 * Where an org admin lands when the fork names nowhere else and has closed
 * {@link DEFAULT_ORG_ADMIN_LANDING} to them (t-929). Members is in no section a
 * fork may close, so it is always open to an org admin.
 */
export const CLOSED_DEFAULT_ORG_ADMIN_LANDING = '/admin/members';

/**
 * Why `route` is not a plain path under `/admin/` — the first rule every
 * landing meets, org admin's or named tier's — or `null` when it is.
 */
function plainPathProblem(route: unknown): string | null {
  if (typeof route !== 'string' || !route.startsWith('/admin/')) {
    return 'is not a path under /admin/.';
  }
  if (!isPlainAdminPath(route)) {
    return 'is not a plain path: literal segments only, with no trailing slash, query, fragment or [x].';
  }
  return null;
}

/**
 * Why an org admin could not land on this page, or `null` when they can.
 * Judges against the org-tier page patterns it is handed.
 */
export function orgAdminLandingProblem(route: unknown, pages: readonly string[]): string | null {
  const pathProblem = plainPathProblem(route);
  if (pathProblem !== null || typeof route !== 'string') return pathProblem;
  // Exactly a listed page, not a URL an `[x]` pattern also names: a concrete
  // `/admin/workflows/abc123` is one org's row, a not-found for every other.
  if (!pages.includes(route)) {
    return 'is not a page an org admin may open. Name a page listed as org-tier, word for word, or list it in lib/app/admin-tier.ts.';
  }
  return null;
}

/**
 * The platform default for an org admin on this install: the orchestration
 * dashboard, or Members when the fork closed orchestration to org admins.
 */
export function defaultOrgAdminLanding(pages: readonly string[]): string {
  return pages.includes(DEFAULT_ORG_ADMIN_LANDING)
    ? DEFAULT_ORG_ADMIN_LANDING
    : CLOSED_DEFAULT_ORG_ADMIN_LANDING;
}

/**
 * Where an org admin lands: the fork's page if they may open it, else the
 * platform default. A fork's page that requires a switch is theirs only when
 * `met` says their org has it (t-1034); otherwise they get the default, which
 * is core's and requires none.
 */
export function orgAdminLanding(met: SwitchMet = NO_SWITCH_MET): string {
  const pages = orgTierAdminPages();
  const route = appOrgAdminLandingRoute;
  if (route === null) return defaultOrgAdminLanding(pages);
  const problem = orgAdminLandingProblem(route, pages);
  if (problem) {
    logger.error('admin-landing: ignoring the app org-admin landing', { route, problem });
    return defaultOrgAdminLanding(pages);
  }
  // Asked of the page's own tier, as the layout asks it: the fork may name a
  // named-tier page, which an org admin also opens.
  const tier = adminPageTierOf(route, pages, namedTierAdminPages()) ?? 'org';
  return switchAllows(met)(route, tier) ? route : defaultOrgAdminLanding(pages);
}

/**
 * Why `route` cannot be where `/admin` sends a holder of `tier` (t-999), or
 * `null` when it can: a plain `/admin/…` path, registered for that tier word
 * for word. A page of another tier would turn the holder away on arrival, and
 * a concrete URL of an `[x]` page is one row of one org.
 */
export function namedTierLandingProblem(
  tier: string,
  route: unknown,
  named: readonly NamedTierAdminPage[]
): string | null {
  const pathProblem = plainPathProblem(route);
  if (pathProblem !== null || typeof route !== 'string') return pathProblem;
  if (!named.some((page) => page.pattern === route && page.tier === tier)) {
    return `is not a page registered for tier ${JSON.stringify(tier)}. Name one registered with registerOrgTierAdminPage(pattern, { tier: ${JSON.stringify(tier)} }), word for word.`;
  }
  return null;
}

/** Landings already logged as unusable, so a misconfigured one is said once per process, not per request. */
const loggedLandingProblems = new Set<string>();

/** Test-only: forget which landings were logged, so a test sees its own log line. */
export function __resetLandingLogForTests(): void {
  loggedLandingProblems.clear();
}

/**
 * Where `/admin` sends someone who holds these tiers and not `'org'` (t-999):
 * for the first named tier they hold, in registration order, its `landing`,
 * or, when it names none, the first page registered for it that has no `[x]`
 * segment. A `landing` that is not one of the tier's own literal pages is
 * logged once and passed over for that default. A page that requires a switch
 * (t-1034), the `landing` or a default, is passed over without a log line
 * when `met` says their org lacks it. `null` only when no tier they hold has a
 * literal page they can open — then `/admin` is not theirs to open, as it is
 * not any MEMBER's.
 */
export function heldTierLanding(
  held: readonly DeclaredAdminTier[],
  met: SwitchMet = NO_SWITCH_MET
): string | null {
  if (held.length === 0) return null;
  const named = namedTierAdminPages();
  const allows = switchAllows(met);
  for (const tier of namedAdminTiers()) {
    if (!held.includes(tier)) continue;
    const route = namedAdminTier(tier)?.landing;
    if (route !== undefined) {
      const problem = namedTierLandingProblem(tier, route, named);
      if (problem === null && allows(route, tier)) return route;
      const key = JSON.stringify([tier, route]);
      if (problem !== null && !loggedLandingProblems.has(key)) {
        loggedLandingProblems.add(key);
        logger.error("admin-landing: ignoring a named tier's landing", { tier, route, problem });
      }
    }
    const first = named.find(
      (page) => page.tier === tier && isPlainAdminPath(page.pattern) && allows(page.pattern, tier)
    );
    if (first) return first.pattern;
  }
  return null;
}
