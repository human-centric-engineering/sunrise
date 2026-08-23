/**
 * Brand seam — the app's display name.
 *
 * Drives user-facing brand strings (layout `<title>` metadata, email
 * templates) so a fork can rename the app with a single env var instead of
 * editing platform-maintained files.
 *
 * Reads `NEXT_PUBLIC_APP_NAME` directly from `process.env` rather than via
 * `lib/env` (which is server-only) so this module is safe to import from BOTH
 * server and client components — Next.js statically inlines the `NEXT_PUBLIC_`
 * value at build time. The var is also registered in `lib/env.ts` for
 * validation/documentation; consume the brand through this constant.
 *
 * Default `'Sunrise'` — unset (or whitespace-only) leaves every surface
 * unchanged, so vanilla Sunrise is byte-for-byte identical.
 *
 * Scope: the brand *name* only. Marketing-page body copy is a separate concern
 * (see `CUSTOMIZATION.md`), and `SUNRISE_VERSION` / internal platform
 * identifiers deliberately do NOT use this seam.
 *
 * `legalName` is the copyright holder / registered legal entity — frequently
 * NOT the product (e.g. product "ConQuest" © "All Too Human Ltd"). It defaults
 * to the product name, so a fork that only sets `NEXT_PUBLIC_APP_NAME` keeps
 * today's output; set `NEXT_PUBLIC_LEGAL_NAME` to attribute legal surfaces (the
 * footer copyright today, Terms/Privacy boilerplate later) to the company.
 *
 * `description` is the root `<meta name="description">` — what search results
 * and social cards show for any page that does not set its own. It defaults to
 * the product name rather than to a sentence, because a wrong sentence is worse
 * than a short one: the previous hardcoded default advertised "a production-ready
 * Next.js starter template" from every fork that had not edited the platform's
 * root layout (#519).
 */
// Resolve the product name once so the `.trim()` and `'Sunrise'` default live in
// a single place; `legalName` falls back to it rather than re-deriving it.
const productName = process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'Sunrise';

// Read once, like `productName` above, so the two description surfaces cannot
// drift apart or diverge from how the variable is spelled here.
const appDescription = process.env.NEXT_PUBLIC_APP_DESCRIPTION?.trim();

export const BRAND = {
  name: productName,
  legalName: process.env.NEXT_PUBLIC_LEGAL_NAME?.trim() || productName,
  description: appDescription || productName,
  /**
   * A full **sentence** for the surfaces where the short default is the wrong
   * trade — today the landing page, whose `<meta name="description">` is what
   * search results and every shared link render, and where `description`'s
   * one-word fallback reads as broken rather than as terse.
   *
   * Same env var, same precedence: a fork that sets
   * `NEXT_PUBLIC_APP_DESCRIPTION` gets it on both. Only the fallback differs.
   * The sentence interpolates the product name and describes nothing
   * product-specific, so it does not re-introduce what #519 removed.
   */
  tagline: appDescription || `Build production-ready applications faster with ${productName}.`,
} as const;
