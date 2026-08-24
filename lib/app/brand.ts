/**
 * App brand identity.
 *
 * **Fork-owned scaffold** — Sunrise ships `null` (= "Sunrise") and does not
 * change this file after release, so your edits merge cleanly on upgrade.
 *
 * Read by `lib/brand.ts`, which every brand-bearing surface already imports:
 * layout metadata, the header `<BrandMark>`, both footers, the email templates.
 * Setting a value here is the whole change.
 *
 * Why code rather than `NEXT_PUBLIC_*`: those are inlined at **build time** and
 * no container build delivered them, so a fork with its brand correctly
 * configured still shipped as "Sunrise" (#661). Brand identity is also a
 * constant of the fork — the same in every environment, not a secret, and
 * better off visible in review.
 *
 * Full guide: CUSTOMIZATION.md §2
 */

/** Product name — page titles, header/footer brand, emails. `null` → "Sunrise". */
export const appBrandName: string | null = null;

/**
 * Copyright holder, where it differs from the product (e.g. product "ConQuest"
 * © "All Too Human Ltd"). `null` → the product name.
 */
export const appBrandLegalName: string | null = null;

/**
 * Root `<meta name="description">`, for any page that sets none of its own.
 * `null` → the product name — deliberately not a sentence, because a wrong
 * sentence is worse than a short one (#519).
 */
export const appBrandDescription: string | null = null;
