/**
 * Brand seam — the app's display name, legal entity and meta description.
 *
 * Drives every user-facing brand string (layout `<title>` metadata, the root
 * meta description, the header `<BrandMark>`, both footers, email templates) so
 * a fork rebrands in one place instead of editing platform-maintained files.
 *
 * Values come from `lib/app/brand.ts`, a committed fork-owned scaffold. The
 * `NEXT_PUBLIC_APP_NAME` / `NEXT_PUBLIC_LEGAL_NAME` / `NEXT_PUBLIC_APP_DESCRIPTION`
 * env vars this used to read were **removed** in the same change that added the
 * scaffold: `NEXT_PUBLIC_*` is inlined at build time and no container build
 * delivered them, so they were a mechanism that silently did nothing on the
 * deployment path most forks use (#661).
 *
 * Unset (or whitespace-only) leaves every surface reading "Sunrise", so vanilla
 * Sunrise is byte-for-byte unchanged.
 *
 * Scope: the product name, legal entity and root description — nothing else. A
 * header logo is a render concern, so that seam is the
 * `components/brand/brand-mark.tsx` scaffold; marketing body copy is fork-owned
 * via the thin-shim pattern; `SUNRISE_VERSION` and internal platform
 * identifiers deliberately do NOT use this seam.
 *
 * @see lib/app/brand.ts · CUSTOMIZATION.md §2
 */
import { appBrandName, appBrandLegalName, appBrandDescription } from '@/lib/app/brand';

/** The three fields a fork sets in `lib/app/brand.ts`. */
export interface BrandSeam {
  name: string | null;
  legalName: string | null;
  description: string | null;
}

/** The resolved brand: what every surface actually renders. */
export interface ResolvedBrand {
  name: string;
  legalName: string;
  description: string;
}

/**
 * Resolve a seam to the brand, applying the trim and the `'Sunrise'` default.
 *
 * Exported as a PURE function so it can be tested by calling it, rather than by
 * mocking `lib/app/brand.ts` and re-importing this module. That distinction is
 * not stylistic. The seam is read at module scope, so driving a different brand
 * through the loader needs `vi.resetModules()` plus a dynamic re-import, which
 * races whatever already holds an evaluated copy — it failed roughly one run in
 * three locally and turned two CI shards red. Pure input, pure output, no
 * registry involved.
 *
 * `legalName` and `description` fall back to the RESOLVED product name, not to
 * the raw seam value, so a fork that sets only the name gets it everywhere.
 */
export function resolveBrand(seam: BrandSeam): ResolvedBrand {
  const name = seam.name?.trim() || 'Sunrise';
  return {
    name,
    legalName: seam.legalName?.trim() || name,
    description: seam.description?.trim() || name,
  };
}

export const BRAND: ResolvedBrand = resolveBrand({
  name: appBrandName,
  legalName: appBrandLegalName,
  description: appBrandDescription,
});
