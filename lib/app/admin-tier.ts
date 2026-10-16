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
 * entered org may open them. A pattern is the path under `app/`: literal
 * segments and `[x]` dynamic ones, nothing else. It covers that one page only,
 * not the pages below it. Put your pages in a section of your own: a pattern
 * whose first segment is dynamic, or one of core's (`CORE_ADMIN_SECTIONS` —
 * `orchestration`, `users`, …), throws.
 *
 * Auto-wired: `orgTierAdminPages()` in `lib/auth/org-tier-admin-pages.ts`
 * calls this once, on the server, before its first read; the admin layout
 * hands the result to the browser-side tier gate and header. Register inside
 * this function, not at the module's top level, so a throw rolls back.
 *
 * Listing a page opens the page only. Its API routes declare their own tier
 * (`withAdminAuth(handler, { tier: 'org', ownership })`), and its nav item
 * carries `tier: 'org'` in `lib/app/admin-nav.ts`. The roster test
 * (`tests/unit/scripts/ci/admin-tier-roster.test.ts`) fails if a page listed
 * here does not exist, if an `[x]` pattern here also names a literal page
 * beside it that is not listed, if an org-tier nav item points at a page
 * nobody listed, or if this function threw.
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
