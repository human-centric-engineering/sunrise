/**
 * Unit Tests: no route module is a copy of another route module
 *
 * ## The defect this exists for
 *
 * `app/(public)/page.tsx` — the landing page — was replaced wholesale with a
 * copy of `app/(public)/about/page.tsx`. The two files were byte-identical, so
 * `/` and `/about` served the same page: the same hero, the same body copy, the
 * same `title: 'About'`. `Pricing` and `FAQ` were left exported from
 * `components/marketing/index.ts` and rendered by nothing.
 *
 * It shipped to `main` and survived a release cut. Nothing in the suite could
 * see it:
 *
 *   - **No test rendered the landing page**, so its body was unasserted.
 *   - **`layout-metadata.test.ts` passed**, and correctly. It stubs the brand
 *     and asks whether any metadata string still says "Sunrise" — the clobbered
 *     page says "About" and reads `BRAND.name`, so it is clean by that
 *     question. A guard against *leaking the starter identity* cannot also be a
 *     guard against *being the wrong page*.
 *   - **`tsc` and ESLint passed**, because a duplicated file is valid on its
 *     own terms. Every signal a route clobber trips is a signal about content
 *     nobody had written an expectation for.
 *
 * ## Why the rule is "no duplicates anywhere" and not "/ is not /about"
 *
 * Pinning the one pair that broke would pass the moment the next pair breaks,
 * and there are 315 route modules. The property that actually holds of this
 * tree is the general one: **two routes that serve identical source are two
 * routes where one has overwritten the other**, because a route module is
 * defined by the URL it answers. Deliberately sharing an implementation is
 * spelled by importing a shared component, never by copying a file. There is
 * therefore no exemption list here — one would rot, and today's 315 modules
 * have no duplicate pair even under whitespace normalisation.
 *
 * That makes it exhaustive rather than enumerated: it fails on the next
 * clobber, not on a re-run of the last one.
 *
 * ## What it does not claim
 *
 * **Byte-identity is the whole rule.** A copy that renames the default export
 * or edits a single literal passes here; `(public)/page.test.tsx` is what
 * covers the one page most worth covering, and no guard covers the rest at
 * that granularity.
 *
 * **A legitimate collision is conceivable**, even if the tree has none: two
 * route groups whose `layout.tsx` are both the trivial `{children}`
 * pass-through, or two `route.ts` that only re-export the same handler, are
 * identical without either having overwritten anything. If that ever lands,
 * add a reasoned exemption here — do **not** perturb bytes to green the run,
 * because a comment added to silence a guard is indistinguishable from the
 * clobber it was meant to catch.
 *
 * `layout.tsx` and `route.ts` are covered for the same reason — a copied layout
 * silently gives a route group another group's chrome, and a copied handler
 * gives an endpoint another endpoint's behaviour, both without a type error.
 *
 * Registered in `ALWAYS_RUN_TESTS` (`scripts/ci/scoped-tests.ts`): its input is
 * the set of files on disk, which no import chain reaches, so `vitest --changed`
 * would never select it.
 *
 * @see app/(public)/page.tsx · tests/unit/app/layout-metadata.test.ts
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';
import { globSync } from 'tinyglobby';

/** The three file kinds Next resolves as a route's own module. */
const ROUTE_MODULE_GLOB = 'app/**/{page,layout,route}.{ts,tsx}';

/** Every route module under `app/`, repo-relative, sorted for stable output. */
function routeModules(): string[] {
  return globSync([ROUTE_MODULE_GLOB], { cwd: process.cwd() }).sort();
}

describe('route module distinctness', () => {
  it('finds the route modules it is supposed to be checking', () => {
    // Guards the guard: a glob that matches nothing passes every assertion
    // below in silence, which is the failure mode this whole file is about.
    // The floor is deliberately far under the real count (315 at the time of
    // writing) so it asserts "the glob works", not "the tree has not grown".
    expect(routeModules().length).toBeGreaterThan(100);
  });

  it('has no two route modules with identical source', () => {
    const byContent = new Map<string, string[]>();

    for (const file of routeModules()) {
      // Exact bytes. Normalising whitespace would let a reformat of a copied
      // file slip through, and a copy is never *nearly* a copy — the failure
      // is a whole-file overwrite.
      const content = readFileSync(file, 'utf8');
      const group = byContent.get(content);
      if (group) group.push(file);
      else byContent.set(content, [file]);
    }

    const duplicates = [...byContent.values()].filter((group) => group.length > 1);

    // Report the paths, not a count: the fix needs to know which file to
    // restore and which one it was overwritten with.
    expect(duplicates.map((group) => group.join('  ==  '))).toEqual([]);
  });
});
