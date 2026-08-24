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
 * FORK NOTE — this file reads `lib/app/reserved-tiers.ts` for real. Declaring a
 * tier there exempts any route module that re-exports from it from the
 * brand-leak row only, because metadata reached through your own tier is your
 * copy rather than a leak of ours. Nothing here needs pinning or editing: an
 * empty declaration (the upstream default) changes nothing at all. The
 * starter-template row is deliberately NOT exempt and runs against every module
 * — if it fires in your fork, it has found real leftover placeholder copy.
 *
 * @see app/layout.tsx · lib/brand.ts · lib/app/reserved-tiers.ts
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Metadata } from 'next';
import { occupiedTiers } from '@/lib/app/reserved-tiers';

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

const APP_DIR = join(process.cwd(), 'app');

/**
 * Every `layout.tsx` / `page.tsx` under `app/`, repo-relative, sorted.
 *
 * DERIVED, not hand-listed (#660). The list used to be seven literal specs behind
 * a `length >= 7` staleness floor, and both halves were wrong:
 *
 *   - **Already incomplete upstream.** `(public)/contact`, `(public)/privacy` and
 *     `(public)/terms` all export metadata and none were listed, so the floor was
 *     guarding a list that had never been complete. Deriving takes the covered
 *     count from 7 to 76.
 *   - **Unfixable in a fork.** Deleting the placeholder About page — which
 *     CUSTOMIZATION.md §6 explicitly invites, and which two forks have already
 *     done — produced `Cannot find package '@/app/(public)/about/page'`: an
 *     unresolvable import, not an assertion failure. Removing the dead row then
 *     broke the floor, so describing your own routes meant editing two things in
 *     a platform test.
 *
 * Reading the directory removes both and retires the floor: a derived list cannot
 * go stale, so there is nothing left to guard against.
 */
function routeModules(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(rel ? join(APP_DIR, rel) : APP_DIR)) {
      const childRel = rel ? `${rel}/${entry}` : entry;
      if (statSync(join(APP_DIR, childRel)).isDirectory()) walk(childRel);
      else if (/^(layout|page)\.tsx$/.test(entry)) out.push(childRel);
    }
  };
  walk('');
  return out.sort();
}

/**
 * Route modules whose metadata may legitimately be the FORK's own copy.
 *
 * Empty upstream — `occupiedTiers` ships `[]`, so nothing matches and every row
 * below runs exactly as it did before. Derived from the tier declaration the fork
 * already makes in `lib/app/reserved-tiers.ts` rather than from a second list, so
 * there is one place to say "I have taken this over", not two.
 *
 * The case it exists for: a fork whose product genuinely IS built on Sunrise and
 * says so in its marketing metadata. The word means "you forgot to rewrite this"
 * in most forks and "this is what we sell" in that one, and only the fork knows
 * which — but a route module whose METADATA comes from the fork's own tier has
 * plainly been taken over, so the platform has no standing to police it.
 *
 * MATCHED ON THE RE-EXPORT, not on the tier appearing anywhere in the file. The
 * first version tested `src.includes('@/<tier>/')`, which 77 of the 87 route
 * modules satisfy through an ordinary component import: a fork declaring
 * `components/app` and putting its shared header there would have exempted
 * `app/layout.tsx` and `(public)/layout.tsx` — the two platform-owned metadata
 * surfaces #519 was actually about — from the row meant to protect them. The
 * question is where the metadata comes from, so that is what is asked.
 *
 * Recognised shapes are `export { … metadata … } from '@/<tier>/…'` and
 * `export * from '@/<tier>/…'`, with or without a trailing path segment. A fork
 * that assembles metadata another way — importing a value then assigning it —
 * is not matched; the failure message names the shapes so it is fixable without
 * reading this file.
 *
 * Deliberately narrow: it exempts a module from the BRAND row only. The
 * starter-template row still runs against every module, because "production-ready
 * Next.js starter template" is never something a fork means to say. Measuring the
 * forks says that split is right — two of them are shipping exactly that text
 * today, from an About page they never rewrote.
 */
function forkOwnedRouteModules(): Set<string> {
  if (occupiedTiers.length === 0) return new Set();
  const owned = new Set<string>();
  for (const rel of routeModules()) {
    const src = readFileSync(join(APP_DIR, rel), 'utf8');
    const reExportsMetadata = occupiedTiers.some((tier) => {
      // `.` is a wildcard in a RegExp and two reserved tiers contain one
      // (`.context/app`, `.context/framework`), so escape before interpolating.
      const path = tier.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
      const target = String.raw`['"\`]@/${path}(?:/|['"\`])`;
      return (
        // export { … metadata … } from '@/<tier>/…'  — the shim pattern
        new RegExp(String.raw`export\s*\{[^}]*\bmetadata\b[^}]*\}\s*from\s*` + target).test(src) ||
        // export * from '@/<tier>/…'                 — barrel re-export
        new RegExp(String.raw`export\s*\*\s*from\s*` + target).test(src)
      );
    });
    if (reExportsMetadata) owned.add(rel);
  }
  return owned;
}

/** `app/(public)/page.tsx` -> `@/app/(public)/page` */
const toSpec = (rel: string): string => `@/app/${rel.replace(/\.tsx$/, '')}`;

/** Flatten a metadata object to every string it contains, at any depth. */
function flatten(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => flatten(v, out));
  else if (value !== null && typeof value === 'object')
    Object.values(value).forEach((v) => flatten(v, out));
  return out;
}

/**
 * One entry per route module that actually serves metadata, strings flattened.
 *
 * Collected once. The hoisted mock above means every import here is already built
 * with the stub brand, so there is no per-case stubbing and nothing to re-import.
 *
 * KNOWN GAP, stated rather than papered over: the four modules exporting
 * `generateMetadata` instead of a static `metadata` object contribute nothing —
 * calling them needs route params and a live database. The hand-listed version
 * did not cover them either, so this is not a regression, but it is not coverage.
 */
const withMetadata: { rel: string; spec: string; strings: string[] }[] = [];
let discovered: string[] = [];

beforeAll(async () => {
  discovered = routeModules();
  for (const rel of discovered) {
    const mod: { metadata?: Metadata } = await import(/* @vite-ignore */ toSpec(rel));
    if (!mod.metadata) continue;
    const strings = flatten(mod.metadata);
    if (strings.length > 0) withMetadata.push({ rel, spec: toSpec(rel), strings });
  }
}, 120_000);

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

  it('the discovery found real modules, and some of them serve metadata', () => {
    // A derived list cannot go stale, but it CAN go empty — a walk that resolves
    // the wrong directory returns [], the loops below then assert over nothing,
    // and the file reports a pass. This row stands between that and a silent green.
    //
    // Both floors are fork-safe on purpose. Counting modules would not be: the
    // forks range from 86 route modules to 155, and a fork may delete most of the
    // marketing surface. Every Next app has a root layout, and this file is
    // pointless if nothing serves metadata — so those are the two things asserted.
    expect(discovered, 'the walk over app/ found no layout.tsx or page.tsx at all').toContain(
      'layout.tsx'
    );
    expect(
      withMetadata.length,
      'no module under app/ exported any metadata string — is the brand mock or the walk broken?'
    ).toBeGreaterThan(0);

    // A module that stops exporting a static `metadata` object is skipped by the
    // collector with NO signal: `if (!mod.metadata) continue`. The hand-listed
    // version could not do that, since it asserted per spec. Converting a layout
    // to `generateMetadata` — a routine Next refactor — or simply dropping its
    // `description` leaves every row below green while that module quietly stops
    // being checked.
    //
    // LAYOUTS ONLY, and only those present on disk, which is what keeps this
    // fork-safe. Forks delete pages routinely — two have deleted
    // `(public)/about`, one `(public)/page` — but a route group's layout is
    // structural, and a fork that removes a whole group loses the pin with it
    // rather than failing.
    const servesMetadata = new Set(withMetadata.map((m) => m.rel));
    const silentLayouts = discovered
      .filter((rel) => /(^|\/)layout\.tsx$/.test(rel))
      .filter((rel) => !servesMetadata.has(rel));

    expect(
      silentLayouts,
      'These layouts serve no static metadata, so the leak rows below skip them silently. ' +
        'If one moved to generateMetadata, this file needs to learn how to call it; if it ' +
        'deliberately serves none, exclude it here so the omission is visible.'
    ).toEqual([]);
  });

  it('names no product but the configured brand', () => {
    const forkOwned = forkOwnedRouteModules();
    const leaks: string[] = [];

    for (const { rel, spec, strings } of withMetadata) {
      if (forkOwned.has(rel)) continue;
      for (const s of strings) if (/\bSunrise\b/i.test(s)) leaks.push(`${spec}: ${s}`);
    }

    expect(
      leaks,
      `These metadata strings still say "Sunrise" with the brand stubbed to "${STUB_BRAND}", so ` +
        `the value is hardcoded rather than read from BRAND. Metadata is what a fork ships to ` +
        `search results and social cards without ever seeing it. (Page *body copy* is fork-owned ` +
        `and out of scope — see lib/brand.ts, "Scope".)\n\n` +
        `IF THIS IS A FORK and the metadata is genuinely yours: declare its tier in ` +
        `lib/app/reserved-tiers.ts rather than editing this file. The exemption applies to a ` +
        `route module whose metadata is RE-EXPORTED from that tier — ` +
        `\`export { default, metadata } from '@/<tier>/…'\` or \`export * from '@/<tier>/…'\` — ` +
        `not to one that merely imports a component from it, since that would exempt almost ` +
        `every route module including the root layout.`
    ).toEqual([]);
  });

  it('does not advertise the starter template', () => {
    // No fork exemption here, deliberately — see forkOwnedRouteModules().
    const leaks: string[] = [];
    for (const { spec, strings } of withMetadata)
      for (const s of strings)
        if (/starter template|Next\.js Starter/i.test(s)) leaks.push(`${spec}: ${s}`);

    expect(
      leaks,
      `These metadata strings advertise the starter template. A route group declaring ` +
        `\`description\` overrides the root outright, so this cannot be fixed from ` +
        `app/layout.tsx alone — which is exactly how #519 first shipped as a no-op. There is no ` +
        `fork exemption for this row: no fork means to say it.`
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

    // An `absolute` title opts OUT of the parent template — that is Next's own
    // semantics, not a special case invented here — so the doubling this row
    // exists to catch cannot occur and there is nothing to assert. A fork that
    // ships its own home page commonly does exactly this: hce-website's is
    // `title: { absolute: 'HCE Studio · Human-Centric Engineering' }`, which made
    // the length assertion below unsatisfiable for them. A third instance of the
    // #660 class, found by simulating the fork rather than by reading the file.
    // `title.absolute` opts out of the parent `title.template` — Next's own
    // semantics — so the doubling cannot occur for that field and it drops out.
    // Only that field: `openGraph.title` and `twitter.title` resolve through
    // their own templates and are still doublable, so returning early here (as
    // the first version did) would skip those too.
    //
    // Note what this does NOT claim: nothing requires those two to exist. A page
    // with an absolute title and no social titles asserts nothing in this row,
    // and that is correct rather than a hole — with no template in play there is
    // no doubling to catch. So the `titles.length > 0` floor applies only when a
    // template can actually apply.
    const titleField = page.metadata?.title;
    const titleIsAbsolute =
      typeof titleField === 'object' && titleField !== null && 'absolute' in titleField;

    const titles = [
      titleIsAbsolute ? undefined : titleField,
      page.metadata?.openGraph?.title,
      page.metadata?.twitter?.title,
    ].filter((t): t is string => typeof t === 'string');

    if (!titleIsAbsolute) {
      expect(
        titles.length,
        'the (public) home page declares neither a string title nor an absolute one — ' +
          'if that is deliberate, this row needs to learn about the new shape'
      ).toBeGreaterThan(0);
    }
    for (const title of titles) {
      expect(
        title.startsWith(STUB_BRAND),
        `page title "${title}" starts with the brand, which the layout template appends again`
      ).toBe(false);
    }
  });
});
