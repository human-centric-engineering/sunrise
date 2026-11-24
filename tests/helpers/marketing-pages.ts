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
 * still the platform's. Gated the way `forkOwnedRouteModules` in
 * `tests/unit/app/layout-metadata.test.ts` is: only a checkout that declares a
 * fork tier in `lib/app/reserved-tiers.ts` is a fork, and only a fork can have
 * taken a page over. Sunrise declares none, so upstream every page is checked,
 * and a page that is missing or re-exported fails rather than being skipped.
 * A fork that shims a page the §6 way already declares `components/app`, since
 * `reserved-fork-tiers.test.ts` fails a fork that fills it without saying so.
 *
 * FORK NOTE: this reads your real `lib/app/reserved-tiers.ts`, unmocked, on
 * purpose: declaring a tier there is what tells it this checkout is a fork.
 * Expect the static-pages test to skip each marketing page you have shimmed
 * or deleted once you declare one, and to check the rest as Sunrise's. There
 * is nothing to pin.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { occupiedTiers } from '@/lib/app/reserved-tiers';

/** The checkout's root, from this file's place in it, not the runner's cwd. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The marketing pages the static-pages test covers, by route segment. */
export const MARKETING_PAGES = ['about', 'contact', 'privacy', 'terms'] as const;
export type MarketingPage = (typeof MARKETING_PAGES)[number];

/**
 * Where a route file re-exports its page from a fork tier:
 * `export { default, … } from '@/<components|lib>/<app|framework>…'`, from a
 * module under the tier or from the tier's own index.
 *
 * Keyed on `default` being re-exported as the file's `default`, not on the
 * tier appearing anywhere in the file: a platform page that merely imports a
 * fork component is still the platform's page, and so is one that re-exports
 * a fork module's default under another name (`default as Hero`). `export *`
 * does not count, because it never re-exports `default`. Comments are
 * stripped first, so a commented-out shim line is not one.
 */
const FORK_TIER_RE_EXPORT =
  /export\s*\{[^}]*\bdefault\b(?!\s+as\b)[^}]*\}\s*from\s*['"]@\/(?:components|lib)\/(?:app|framework)(?:\/|['"])/;

/** `source` without its comments: enough for the export lines matched here. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Whether a route file's source re-exports its page from a fork tier, as a §6 shim does. */
export function isForkShim(source: string): boolean {
  return FORK_TIER_RE_EXPORT.test(withoutComments(source));
}

/** The route file of a marketing page, absolute. */
export function marketingPageFile(page: MarketingPage, root: string = REPO_ROOT): string {
  return path.join(root, 'app', '(public)', page, 'page.tsx');
}

interface Checkout {
  /** The checkout's root. Defaults to this repository's. */
  root?: string;
  /** The fork tiers it declares. Defaults to `lib/app/reserved-tiers.ts`. */
  tiers?: readonly string[];
}

/**
 * Whether this checkout still ships `page` as the platform's own page. Always
 * true in a checkout that declares no fork tier, which is Sunrise; in a fork,
 * true unless the route file is gone or is a shim.
 */
export function isPlatformMarketingPage(
  page: MarketingPage,
  { root = REPO_ROOT, tiers = occupiedTiers }: Checkout = {}
): boolean {
  if (tiers.length === 0) return true;
  const file = marketingPageFile(page, root);
  if (!existsSync(file)) return false;
  return !isForkShim(readFileSync(file, 'utf8'));
}
