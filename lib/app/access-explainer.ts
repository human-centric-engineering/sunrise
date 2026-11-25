/**
 * App words for the access explainer: who can do what in the admin console
 * (§143).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * The explainer (`GET /api/v1/admin/access`) already shows everything your registrations decide: your org-tier pages
 * (`lib/app/admin-tier.ts`), your named tiers, with the `label` and
 * `description` you give them in `registerAdminTier()`, and your entitlement
 * switches (`lib/app/entitlements.ts`). Each viewer sees their own slice: a
 * platform admin everything, an org's OWNER/ADMIN their org's view, and a
 * holder of one of your named tiers only those tiers. Here you add the words
 * and the arrangement, with the functions in
 * `lib/auth/access-explainer-registry.ts`:
 *
 * - `registerAccessArea()` — group your pages into areas, as your sidebar
 *   does, with a label and a description;
 * - `registerPlatformOnlySurface()` — what you keep for the platform, and why;
 * - `setAccessSectionAudience()` — which viewers see each of the explainer's
 *   own sections;
 * - `registerAccessSection()` — a section of your own, such as how your
 *   packages work or who to ask.
 *
 * Text is plain, or `{ message: 'app.…' }` naming a key you add in
 * `lib/app/messages.ts`, which is then shown in the viewer's language.
 * Sunrise's own words (role descriptions, section headings, core's areas)
 * are the platform catalogue's, under `admin.access`: change them with
 * `overridePlatformMessages()` there, not here.
 *
 * None of this opens or closes anything. Who may open a page is decided by
 * `lib/app/admin-tier.ts` and the authorization policy, and the explainer
 * only reads them.
 *
 * Auto-wired: `lib/auth/access-explainer.ts` calls this once, lazily, on the
 * server, before its first read. Register inside this function, not at the
 * module's top level, so a throw rolls back. If it throws, none of it is
 * registered: the explainer shows Sunrise's own words and what your
 * registrations decide, and the log says why.
 *
 * @example
 * ```ts
 * import {
 *   registerAccessArea,
 *   registerAccessSection,
 *   registerPlatformOnlySurface,
 *   setAccessSectionAudience,
 * } from '@/lib/auth/access-explainer-registry';
 *
 * export function initAppAccessExplainer(): void {
 *   registerAccessArea({
 *     key: 'reports',
 *     label: 'Reports',
 *     description: 'Build and share reports from collected answers.',
 *     pages: ['/admin/reports'],
 *   });
 *   registerPlatformOnlySurface({
 *     key: 'billing',
 *     label: 'Billing',
 *     reason: 'Your plan is managed by our account team. Ask them to change it.',
 *   });
 *   setAccessSectionAudience('switches', ['platform', 'org']);
 *   registerAccessSection({
 *     key: 'agency',
 *     title: { message: 'app.access.agency.title' },
 *     body: { message: 'app.access.agency.body' },
 *     audience: ['org', 'holder'],
 *   });
 * }
 * ```
 *
 * Full guide: .context/auth/access-explainer.md · CUSTOMIZATION.md §4
 */
export function initAppAccessExplainer(): void {
  // No app words for the access explainer by default.
}
