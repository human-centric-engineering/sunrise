/**
 * Which of the platform's marketing pages a checkout still ships as Sunrise's
 * own, for `tests/unit/app/(public)/static-pages.test.tsx` (#1317).
 *
 * That test asserts the platform's copy: it renders each page and expects the
 * catalogue's headings, and it calls the page's `generateMetadata`. Both are
 * right for Sunrise's pages and wrong for a fork that has taken a page over the
 * way CUSTOMIZATION.md §6 says to, by reducing the route file to a one-line
 * re-export of its own content:
 *
 * ```tsx
 * // app:shim — replaced by app-owned content; keep this line on upstream merges
 * export { default, metadata } from '@/components/app/marketing/contact-page';
 * ```
 *
 * A static `import { generateMetadata } from '@/app/(public)/contact/page'`
 * then fails type-check (TS2614: the shim exports `metadata`), and every copy
 * assertion fails, because the page renders the fork's words. §6 also invites
 * deleting a placeholder page, which makes the import unresolvable. Neither is
 * a defect in the fork, and the fork could only fix it by editing this
 * platform test, which is the merge cost §6 exists to avoid.
 *
 * So the test asks here first, and runs a page's checks only while the page is
 * still the platform's. The same answer as `forkOwnedRouteModules` in
 * `tests/unit/app/layout-metadata.test.ts`: a route module whose content comes
 * from a fork tier has been taken over, and the platform has no standing to
 * assert its copy.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The marketing pages the static-pages test covers, by route segment. */
export const MARKETING_PAGES = ['about', 'contact', 'privacy', 'terms'] as const;
export type MarketingPage = (typeof MARKETING_PAGES)[number];

/**
 * Where a route file re-exports its page from a fork tier.
 *
 * Matches `export { …default… } from '@/<components|lib>/<app|framework>/…'`
 * and `export * from …` on the same paths. Both tiers are reserved for forks
 * (`platform.reserved-tiers`): Sunrise never creates a file under either, so
 * upstream this can never match a platform page.
 *
 * Keyed on `default` being re-exported, not on the tier appearing anywhere in
 * the file: a platform page that merely imports a fork component is still the
 * platform's page.
 */
const FORK_TIER_RE_EXPORT =
  /export\s*(?:\{[^}]*\bdefault\b[^}]*\}|\*)\s*from\s*['"]@\/(?:components|lib)\/(?:app|framework)\//;

/** The `app:shim` region comment §6 asks a shim to carry. */
const SHIM_MARKER = /\/\/\s*app:shim\b/;

/** Whether a route file's source is a fork's §6 shim rather than the platform's page. */
export function isForkShim(source: string): boolean {
  return FORK_TIER_RE_EXPORT.test(source) || SHIM_MARKER.test(source);
}

/** The route file of a marketing page, absolute. */
export function marketingPageFile(page: MarketingPage, cwd: string = process.cwd()): string {
  return path.join(cwd, 'app', '(public)', page, 'page.tsx');
}

/**
 * Whether this checkout still ships `page` as the platform's own page: the
 * route file exists and is not a fork's shim.
 */
export function isPlatformMarketingPage(page: MarketingPage, cwd: string = process.cwd()): boolean {
  const file = marketingPageFile(page, cwd);
  if (!existsSync(file)) return false;
  return !isForkShim(readFileSync(file, 'utf8'));
}
