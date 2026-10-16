/**
 * App admin pages an org admin may open.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * Every admin page is the platform's — platform admins only — unless it is
 * listed as org-tier. Core lists its own in `ORG_TIER_ADMIN_PAGES`; list
 * yours here with `registerOrgTierAdminPage()`, and an org OWNER/ADMIN of the
 * entered org may open them. A pattern is the path under `app/` with dynamic
 * segments written as the directory names them, and it covers that one page
 * only, not the pages below it.
 *
 * Auto-wired: `adminPageTier()` in `lib/auth/admin-tier.ts` calls this once,
 * before its first read, in whichever realm reads first — the admin layout on
 * the server, the tier gate and header in the browser. So this file must stay
 * client-safe: the registrar import only, no server code.
 *
 * Listing a page opens the page only. Its API routes declare their own tier
 * (`withAdminAuth(handler, { tier: 'org', ownership })`), and its nav item
 * carries `tier: 'org'` in `lib/app/admin-nav.ts`. The roster test
 * (`tests/unit/scripts/ci/admin-tier-roster.test.ts`) fails if a page listed
 * here does not exist, or if an org-tier nav item points at a page nobody
 * listed.
 *
 * If this function throws, none of its pages open: the registry rolls back to
 * core's list and logs why.
 *
 * @example
 * ```ts
 * import { registerOrgTierAdminPage } from '@/lib/auth/admin-tier';
 *
 * export function initAppOrgTierAdminPages(): void {
 *   registerOrgTierAdminPage('/admin/reports');
 *   registerOrgTierAdminPage('/admin/reports/[id]');
 * }
 * ```
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/auth/authorization.md "Admin tiers"
 */
export function initAppOrgTierAdminPages(): void {
  // No app org-tier admin pages by default.
}
