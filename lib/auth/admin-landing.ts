/**
 * Where `/admin` sends each viewer (t-928).
 *
 * A platform admin lands on the overview, which is install-wide and theirs
 * alone. An org OWNER/ADMIN lands on the orchestration dashboard, unless the
 * fork names another page in `lib/app/admin-landing.ts`.
 *
 * The fork's page is used only if an org admin may open it: a path under
 * `/admin/` with literal segments, on the org-tier roster (core's or the
 * fork's). Anything else would turn them away the moment they arrived — to the
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
import { adminPageTier } from '@/lib/auth/admin-tier';
import { orgTierAdminPages } from '@/lib/auth/org-tier-admin-pages';

/** Where a platform admin lands. */
export const PLATFORM_ADMIN_LANDING = '/admin/overview';

/** Where an org admin lands when the fork names nowhere else. */
export const DEFAULT_ORG_ADMIN_LANDING = '/admin/orchestration';

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
  if (adminPageTier(route, pages) !== 'org') {
    return 'is not a page an org admin may open. List it in lib/app/admin-tier.ts, or name an org-tier page.';
  }
  return null;
}

/** Where an org admin lands: the fork's page if they may open it, else the platform default. */
export function orgAdminLanding(): string {
  const route = appOrgAdminLandingRoute;
  if (route === null) return DEFAULT_ORG_ADMIN_LANDING;
  const problem = orgAdminLandingProblem(route, orgTierAdminPages());
  if (problem) {
    logger.error('admin-landing: ignoring the app org-admin landing', { route, problem });
    return DEFAULT_ORG_ADMIN_LANDING;
  }
  return route;
}
