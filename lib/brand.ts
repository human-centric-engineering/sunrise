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
 */
export const BRAND = {
  name: process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'Sunrise',
} as const;
