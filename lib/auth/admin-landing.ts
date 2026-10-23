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
 * Server only: it reads the roster through `orgTierAdminPages()`, which runs
 * the fork's page init.
 *
 * @see lib/app/admin-landing.ts — the fork's choice
 * @see app/admin/page.tsx — the one caller
 */
import { logger } from '@/lib/logging';
import { appOrgAdminLandingRoute } from '@/lib/app/admin-landing';
import { orgTierAdminPages } from '@/lib/auth/org-tier-admin-pages';

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

/** One literal segment of a URL path: no query, fragment, or `[x]`. */
const LITERAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/**
 * Why an org admin could not land on this page, or `null` when they can.
 * Judges against the org-tier page patterns it is handed.
 */
export function orgAdminLandingProblem(route: unknown, pages: readonly string[]): string | null {
  if (typeof route !== 'string' || !route.startsWith('/admin/')) {
    return 'is not a path under /admin/.';
  }
  if (
    !route
      .split('/')
      .slice(2)
      .every((segment) => LITERAL_SEGMENT.test(segment))
  ) {
    return 'is not a plain path: literal segments only, with no trailing slash, query, fragment or [x].';
  }
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

/** Where an org admin lands: the fork's page if they may open it, else the platform default. */
export function orgAdminLanding(): string {
  const pages = orgTierAdminPages();
  const route = appOrgAdminLandingRoute;
  if (route === null) return defaultOrgAdminLanding(pages);
  const problem = orgAdminLandingProblem(route, pages);
  if (problem) {
    logger.error('admin-landing: ignoring the app org-admin landing', { route, problem });
    return defaultOrgAdminLanding(pages);
  }
  return route;
}
