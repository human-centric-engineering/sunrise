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
 *   - **No test rendered the landing page**, and deliberately so: it is a
 *     placeholder every fork rewrites or deletes, and a core test pinning its
 *     content is a core test a fork cannot satisfy (#480, #525, #530, #533).
 *     That is a correct decision which happens to leave whole-file overwrites
 *     invisible — hence a structural guard here rather than a content one.
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
 * and there are 325 route modules. The property that actually holds of this
 * tree is the general one: **two routes that serve identical source are two
 * routes where one has overwritten the other**, because a route module is
 * defined by the URL it answers. Deliberately sharing an implementation is
 * spelled by importing a shared component, never by copying a file. There is
 * therefore nothing exempt upstream: today's 325 modules have no duplicate pair
 * even under whitespace normalisation, and {@link ALLOWED_IDENTICAL_GROUPS}
 * ships empty. It exists so that a fork with a genuine collision appends a row
 * instead of editing this file's logic — the same additive-merge convention
 * `ALWAYS_RUN_TESTS` documents in `scripts/ci/scoped-tests.ts`.
 *
 * That makes it exhaustive rather than enumerated: it fails on the next
 * clobber, not on a re-run of the last one.
 *
 * ## What it does not claim
 *
 * **Byte-identity is the whole rule.** A copy that renames the default export
 * or edits a single literal passes here, and nothing else covers that — the
 * marketing pages under `(public)/` are fork-owned placeholders that Sunrise
 * deliberately does not pin with content tests, so a whole-file overwrite is
 * the shape this can catch and a near-copy is not.
 *
 * **A legitimate collision is conceivable**, even if this tree has none: two
 * route groups whose `layout.tsx` are both the trivial `{children}`
 * pass-through, or two `route.ts` that only re-export the same handler, are
 * identical without either having overwritten anything. A fork is the likely
 * place — there are already four `loading.tsx` here, and adding a fifth by
 * copying an existing spinner is the natural way to do it.
 *
 * Declare it in {@link ALLOWED_IDENTICAL_GROUPS} with a reason. Do **not**
 * perturb bytes to green the run: a comment added to silence a guard is
 * indistinguishable from the clobber it was meant to catch.
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

/**
 * Every file kind Next resolves as a route segment's own module.
 *
 * The full set, not the three obvious ones: the docblock's rationale — "a
 * copied layout silently gives a route group another group's chrome" — applies
 * verbatim to a copied `error.tsx` or `not-found.tsx`, and a guard that calls
 * itself exhaustive should not stop at the kinds that happened to break.
 * `template` and `default` match nothing in this tree today and are listed so
 * that adding one is covered on arrival rather than on the next review.
 */
const ROUTE_MODULE_GLOB =
  'app/**/{page,layout,route,error,loading,not-found,template,default,global-error}.{ts,tsx}';

/**
 * Groups of route modules that are allowed to be byte-identical.
 *
 * **Empty upstream, and Sunrise must keep it that way** — a core entry would
 * mean core had a clobber it decided to live with. It is exported and declared
 * here so a fork appends rather than edits: additive on merge, the convention
 * `ALWAYS_RUN_TESTS` (`scripts/ci/scoped-tests.ts`) already sets for whole-tree
 * invariants a fork has to extend.
 *
 * Each entry is the full set of paths permitted to share content, plus why.
 * Listing a pair does not weaken the rule for anything else: a third file that
 * matches a declared group still fails, because the group is compared by exact
 * membership.
 */
export const ALLOWED_IDENTICAL_GROUPS: readonly { paths: readonly string[]; reason: string }[] = [];

/** Every route module under `app/`, repo-relative, sorted for stable output. */
function routeModules(): string[] {
  return globSync([ROUTE_MODULE_GLOB], { cwd: process.cwd() }).sort();
}

describe('route module distinctness', () => {
  it('finds the route modules it is supposed to be checking', () => {
    // Guards the guard: a glob that matches nothing passes the duplicate
    // assertion below in silence, which is the failure mode this whole file is
    // about.
    //
    // Anchored on the root layout rather than on a count. Next requires
    // `app/layout.tsx` in every App Router application, so this holds for the
    // smallest possible fork; a numeric floor would not. An earlier draft used
    // `> 100` against a then-current 315 — a leaf fork that strips the
    // orchestration admin surface (248 of the 325 route modules here sit under
    // it) drops below that and gets a red test saying nothing true about its
    // tree. 228 appeared here in an earlier draft — that is the number of
    // `route.ts` files in the whole tree, a different measurement that happened
    // to look plausible.
    const modules = routeModules();

    expect(modules).toContain('app/layout.tsx');
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

    const allowed = new Set(
      ALLOWED_IDENTICAL_GROUPS.map((group) => [...group.paths].sort().join('\u0000'))
    );

    const duplicates = [...byContent.values()]
      .filter((group) => group.length > 1)
      // Exact membership, not subset: a third file joining a declared pair is a
      // new collision and must still fail.
      .filter((group) => !allowed.has([...group].sort().join('\u0000')));

    // Report the paths, not a count: the fix needs to know which file to
    // restore and which one it was overwritten with.
    expect(duplicates.map((group) => group.join('  ==  '))).toEqual([]);
  });
});
