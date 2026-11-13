/**
 * App admin breadcrumb labels.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its value).
 *
 * Auto-wired: `components/admin/admin-header.tsx` reads it (client runtime) to
 * name the URL segments of your own admin pages in the breadcrumb and, for
 * the last segment, the page title. Keys are single path segments, not paths:
 * `'settings-profiles': 'Settings library'` names that segment wherever it
 * appears under `/admin`.
 *
 * The header resolves a segment's label in this order:
 *   1. a label the page registered with `<BreadcrumbLabel>`
 *      (`components/admin/breadcrumb-context.tsx`) — for record ids;
 *   2. this map;
 *   3. Sunrise's own labels for its core segments;
 *   4. the segment title-cased (`some-section` → `Some Section`), unless it
 *      has a digit: that is almost always a record id, left as typed.
 * The page title takes 1–3 only, never a title-cased id.
 *
 * An entry here can rename a core segment too, since it wins over step 3.
 *
 * Boundary-clean: no imports, so it stays within the `lib/app/**` boundary
 * and is safe in the client bundle.
 *
 * Full guide: CUSTOMIZATION.md §4
 */
export const appSegmentLabels: Readonly<Record<string, string>> = {};
