/**
 * App admin API routes an org admin may call.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its value).
 *
 * A route is opened to an org OWNER/ADMIN at its call site, not here:
 * `withAdminAuth(handler, { tier: 'org', ownership })`. That declaration is
 * what the guard acts on. This list is the review half: the roster test
 * (`tests/unit/scripts/ci/admin-tier-roster.test.ts`) fails on a route that
 * declares `tier: 'org'` without being listed here or in core's
 * `ORG_TIER_ADMIN_ROUTES`, and on one listed here that does not declare it.
 * So opening one of your routes is always a line in this file a reviewer can
 * see, without editing core's list.
 *
 * Each entry is `path#NAME`: the file's path from the repo root, then the
 * handler's HTTP method, or the name of a wrapper that bakes the tier in.
 * List the wrapper, not each route that uses it.
 *
 * Nothing reads this at runtime; it changes no answer the guard gives.
 *
 * @example
 * ```ts
 * export const APP_ORG_TIER_ADMIN_ROUTES: readonly string[] = [
 *   'app/api/v1/app/reports/route.ts#GET',
 *   'app/api/v1/app/reports/_lib/read-route.ts#withReportsRead',
 * ];
 * ```
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/auth/authorization.md "Admin tiers"
 */
export const APP_ORG_TIER_ADMIN_ROUTES: readonly string[] = [];
