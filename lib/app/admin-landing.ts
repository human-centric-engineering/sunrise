/**
 * Where an org admin lands in the admin console.
 *
 * **Fork-owned scaffold** — Sunrise ships this `null` (= use the platform
 * default, `/admin/orchestration`) and does NOT change this file after
 * release, so your edits here merge cleanly on upgrade (the stable contract is
 * this file's export, not its value).
 *
 * `/admin` sends a platform admin to the overview and an org OWNER/ADMIN to
 * this page. Set it when your customers come to the console for something
 * other than running agents.
 *
 * It must be a page an org admin may open: a path under `/admin/` with literal
 * segments only (no query or fragment), listed word for word as org-tier by
 * core (`ORG_TIER_ADMIN_PAGES`) or by you (`lib/app/admin-tier.ts`) — not one
 * row of an `[x]` page, which belongs to one org. A page they
 * cannot open would turn them away as soon as they landed. A value that fails
 * that is not used: `/admin` logs an error and sends them to the platform
 * default instead, and the roster test
 * (`tests/unit/scripts/ci/admin-tier-roster.test.ts`) fails.
 *
 * @example
 * ```ts
 * export const appOrgAdminLandingRoute: string | null = '/admin/reports';
 * ```
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/auth/authorization.md "Admin tiers"
 */

/** Where an org admin lands at `/admin`. `null` = platform default (`/admin/orchestration`). */
export const appOrgAdminLandingRoute: string | null = null;
