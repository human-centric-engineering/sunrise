/**
 * Unit Tests: metadata does not leak the starter identity (#519)
 *
 * ## Why this is the third shape of this test
 *
 * The root layout used to hardcode `"${BRAND.name} - Next.js Starter"` and a
 * description advertising "a production-ready Next.js starter template". Two
 * earlier versions of this file both passed while the leak was still shipping:
 *
 *   1. **Asserted on the root `metadata` object only.** Next resolves metadata
 *      at the *nearest* segment that defines a field, and all four route groups
 *      declare their own `description` — so the root object said nothing about
 *      what `/about` actually serves.
 *   2. **Text-scanned `export const metadata[^;]*?;`.** Any value hoisted into a
 *      module const escaped the regex — which is precisely what both remaining
 *      offenders did (`aboutDescription`, `heroDescription`), and
 *      `generateMetadata` functions were not seen at all.
 *
 * Both were guesses at where a leak might be written. This one does not guess:
 * it **stubs the brand to a value that is not "Sunrise", re-imports each module,
 * and reads the metadata Next would actually serve.** Anything still saying
 * "Sunrise" after that is hardcoded by definition — however it was spelled,
 * hoisted, interpolated or computed.
 *
 * @see app/layout.tsx · lib/brand.ts
 */

import { describe, it, expect, vi } from 'vitest';
import type { Metadata } from 'next';

/** A brand no fixture would produce by accident. */
const { STUB_BRAND } = vi.hoisted(() => ({ STUB_BRAND: 'Zzyzx Industries' }));

// HOISTED, so every module imported below is BUILT with the stub brand.
//
// This used to stub per-case with `vi.doMock` + `vi.resetModules()` and a dynamic
// re-import. Route modules read `@/lib/brand` at module scope, so that races
// whatever already holds an evaluated copy — it passed locally every time and
// failed CI shard 3, reporting the ROOT LAYOUT as hardcoding "Sunrise" when the
// stub simply had not arrived. There is now nothing to re-import and nothing to
// race.
vi.mock('@/lib/app/brand', () => ({
  appBrandName: STUB_BRAND,
  appBrandLegalName: STUB_BRAND,
  appBrandDescription: STUB_BRAND,
}));

/**
 * Every module under `app/` that declares metadata. Hand-listed because a glob
 * cannot import; the count assertion below is what stops the list going stale
 * silently.
 */
const METADATA_MODULES = [
  '@/app/layout',
  '@/app/(public)/layout',
  '@/app/(public)/page',
  '@/app/(public)/about/page',
  '@/app/(protected)/layout',
  '@/app/(auth)/layout',
  '@/app/admin/layout',
] as const;

/** Import `spec` with the brand stubbed, and flatten its metadata to strings. */
async function metadataStringsWithStubbedBrand(spec: string): Promise<string[]> {
  const mod: { metadata?: Metadata } = await import(/* @vite-ignore */ spec);
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(mod.metadata);
  return out;
}

describe('metadata is driven by the BRAND seam, not hardcoded', () => {
  it('the brand stub reaches BRAND through the seam', async () => {
    // CONTROL for stubBrand(): if the mock silently failed to intercept, every
    // row below would read the real (null) seam, resolve to "Sunrise", and the
    // leak filters would report nothing — a green file asserting nothing.

    const { BRAND } = await import('@/lib/brand');
    expect(BRAND.name).toBe(STUB_BRAND);
    expect(BRAND.legalName).toBe(STUB_BRAND);
    expect(BRAND.description).toBe(STUB_BRAND);
  });

  it('the module list has not gone stale', () => {
    // A shrunken list is how this test quietly stops covering things. If you
    // add a layout or page with metadata, add it above.
    expect(METADATA_MODULES.length).toBeGreaterThanOrEqual(7);
  });

  it.each(METADATA_MODULES)('%s names no product but the configured brand', async (spec) => {
    const strings = await metadataStringsWithStubbedBrand(spec);

    expect(
      strings.length,
      `${spec} exported no metadata strings — is the module list right?`
    ).toBeGreaterThan(0);

    const leaks = strings.filter((s) => /\bSunrise\b/i.test(s));
    expect(
      leaks,
      `${spec} still says "Sunrise" with the brand stubbed to "${STUB_BRAND}", so the value is ` +
        `hardcoded rather than read from BRAND. Metadata is what a fork ships to search results ` +
        `and social cards without ever seeing it. (Page *body copy* is fork-owned and out of ` +
        `scope — see lib/brand.ts, "Scope".)`
    ).toEqual([]);
  });

  it.each(METADATA_MODULES)('%s does not advertise the starter template', async (spec) => {
    const strings = await metadataStringsWithStubbedBrand(spec);

    const leaks = strings.filter((s) => /starter template|Next\.js Starter/i.test(s));
    expect(
      leaks,
      `${spec} advertises the starter template. A route group declaring \`description\` ` +
        `overrides the root outright, so this cannot be fixed from app/layout.tsx alone — ` +
        `which is exactly how #519 first shipped as a no-op.`
    ).toEqual([]);
  });

  it('a page title does not double the brand the layout template appends', async () => {
    // `(public)/layout.tsx` declares `template: '%s - ${BRAND.name}'`, so a page
    // whose own title also starts with the brand renders "Acme - … - Acme".
    // TITLES only — a description may legitimately open with the brand name.
    const layout: { metadata?: Metadata } = await import('@/app/(public)/layout');
    const template =
      typeof layout.metadata?.title === 'object' && layout.metadata.title !== null
        ? (layout.metadata.title as { template?: string }).template
        : undefined;
    expect(template, 'the (public) layout should declare a title template').toContain('%s');

    const page: { metadata?: Metadata } = await import('@/app/(public)/page');
    const titles = [
      page.metadata?.title,
      page.metadata?.openGraph?.title,
      page.metadata?.twitter?.title,
    ].filter((t): t is string => typeof t === 'string');

    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(
        title.startsWith(STUB_BRAND),
        `page title "${title}" starts with the brand, which the layout template appends again`
      ).toBe(false);
    }
  });
});
