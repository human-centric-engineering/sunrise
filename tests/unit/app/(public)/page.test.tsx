// @vitest-environment happy-dom

/**
 * Landing Page Tests
 *
 * ## Why this file exists
 *
 * `app/(public)/page.tsx` was replaced wholesale with a byte-identical copy of
 * `app/(public)/about/page.tsx`, and `/` served the About page through a
 * release cut. Nothing caught it, and the reason is this file's absence: no
 * test rendered the landing page, so its body had no expectation to violate.
 * `layout-metadata.test.ts` passed correctly throughout — it asks whether
 * metadata leaks the starter identity, which a clobbered page does not.
 *
 * So most assertions here are deliberately about **identity**, not liveness. A
 * "renders without crashing" test would have passed against the About page too,
 * which is the whole failure.
 *
 * **Eight of the ten are identity assertions; two are not.** "offers the
 * primary signup call to action" holds for the About page as well, which also
 * ships a `/signup` primary action. That is fine — it is a behaviour assertion,
 * not an identity one — but it is recorded here because the count is what a
 * future editor needs when deciding whether an assertion still earns its
 * place, and an earlier draft of this docblock claimed all of them named
 * something only the landing page has. Verified by rendering the clobbered
 * page: eight fail, two pass.
 *
 * `route-module-distinctness.test.ts` guards the same defect from the other
 * side — that no two route modules are byte-identical. Two different questions:
 * that one catches a copy of *any* page over *any* other, this one catches the
 * landing page being edited into something that is no longer a landing page.
 *
 * The body copy itself is fork-owned — a fork is expected to rewrite it — so
 * these assertions anchor on the **section ids** (`features`, `pricing`, `faq`)
 * and the marketing components' presence rather than on the prose, which a fork
 * changes and upstream should not pin.
 *
 * @see app/(public)/page.tsx · tests/unit/app/route-module-distinctness.test.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Metadata } from 'next';

import LandingPage, { metadata } from '@/app/(public)/page';

/**
 * Re-import the page's metadata with `NEXT_PUBLIC_APP_DESCRIPTION` set to
 * `value`, or genuinely **absent** when `value` is `undefined`.
 *
 * Absent, not empty. `vi.stubEnv(key, undefined)` deletes the key; stubbing
 * `''` leaves it present-but-blank, which is not the state a fork is in. Both
 * satisfy today's `||`, so the distinction is invisible now — but a refactor to
 * `?? fallback`, which is correct for the real absent case, would turn this
 * test red for a change that is fine in production.
 *
 * The description assertions have to go through this rather than reading the
 * statically-imported `metadata`, because in the default test environment the
 * seam and the brand name are **the same string**: `BRAND.description` falls
 * back to `productName`, which is also `BRAND.name`. A plain
 * `expect(metadata.description).toBe(BRAND.description)` therefore holds even
 * if the page were changed to `BRAND.name` — verified by mutation, 24/24 green
 * — so it could not fail for the confusion it named. Two constants that
 * coincide make an equality assertion blind.
 */
async function metadataWithDescription(value: string | undefined): Promise<Metadata> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_APP_DESCRIPTION', value);

  const mod: { metadata: Metadata } = await import('@/app/(public)/page');
  return mod.metadata;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('LandingPage', () => {
  describe('metadata', () => {
    it('titles the page "Home", not the name of another route', () => {
      // The literal that regressed: the clobbered file carried `title: 'About'`.
      expect(metadata.title).toBe('Home');
    });

    it('lets both social cards inherit the resolved page title', () => {
      // With no title of their own, Next copies the already-resolved
      // "Home - <brand>" into openGraph and twitter — one string to keep
      // correct rather than three.
      //
      // NOT because the layout's `%s - ${BRAND.name}` template would double a
      // card title: it would not. Next derives `titleTemplates.openGraph` from
      // an ancestor's `openGraph.title`, and no ancestor here declares an
      // `openGraph` block at all. `about/page.tsx` ships an explicit
      // `openGraph.title` and renders it verbatim.
      expect(metadata.openGraph?.title).toBeUndefined();
      expect(metadata.twitter?.title).toBeUndefined();
    });

    it("uses the fork's own description when it has set one", async () => {
      const sentinel = 'Zzyzx Industries coordinates municipal drainage.';
      const resolved = await metadataWithDescription(sentinel);

      expect(resolved.description).toBe(sentinel);
      expect(resolved.openGraph?.description).toBe(sentinel);
      expect(resolved.twitter?.description).toBe(sentinel);
    });

    // There is deliberately NO "does not hardcode the product identity" test
    // here. `layout-metadata.test.ts` lists `@/app/(public)/page` in
    // METADATA_MODULES and applies both the `/starter template/i` filter and a
    // `\bSunrise\b` filter under a stubbed brand, so it already covers this
    // page's composed sentence — and strictly better. The version that stood
    // here checked only the two phrases, so `Build faster with Sunrise.` passed
    // it 10/10 while the existing guard failed it. A weaker duplicate under a
    // stronger name is worse than no test: it reads as coverage.

    it('falls back to a sentence, not to the bare product name', async () => {
      const resolved = await metadataWithDescription(undefined);
      const description = resolved.description;

      // The regression this guards: `BRAND.description` defaults to the
      // product name, so taking the seam directly shipped a one-word
      // <meta description> on the most-indexed page in the app.
      expect(typeof description).toBe('string');
      expect((description as string).split(/\s+/).length).toBeGreaterThan(3);
      expect(description).toMatch(/\.$/);
    });
  });

  describe('page identity', () => {
    it('renders the marketing sections that make this the landing page', () => {
      const { container } = render(<LandingPage />);

      // Section ids rather than copy: a fork rewrites the prose and keeps the
      // structure, so pinning the prose would fail every fork.
      for (const id of ['features', 'how-it-works', 'pricing', 'faq']) {
        expect(container.querySelector(`#${id}`), `missing section #${id}`).not.toBeNull();
      }
    });

    it('renders the pricing and FAQ blocks that no other page consumes', () => {
      // `Pricing` and `FAQ` are exported from `components/marketing/index.ts`
      // and rendered by this page alone. When it was clobbered both became
      // orphaned exports, which nothing else in the suite would have noticed.
      //
      // These assertions must reach INSIDE the sections. The first version of
      // this test matched "Simple, Transparent Pricing" and "Frequently Asked
      // Questions" — both `<Section title>` props, rendered by `Section`, not
      // by `Pricing` or `FAQ`. Deleting both components from the page left all
      // eight tests passing, so the half of the defect this test names was
      // entirely unguarded. Found by /code-review, confirmed by that mutation.
      //
      // Structure, not copy: a fork rewrites its tiers and questions, so this
      // asserts on what the two components emit — a CTA link per pricing tier,
      // and Radix's `aria-expanded` accordion triggers — never on the prose.
      const { container } = render(<LandingPage />);

      const pricing = container.querySelector('#pricing');
      expect(pricing).not.toBeNull();
      expect(
        pricing!.querySelectorAll('a[href]').length,
        'no tier CTA links inside #pricing — is <Pricing> still rendered?'
      ).toBeGreaterThan(0);

      const faq = container.querySelector('#faq');
      expect(faq).not.toBeNull();
      expect(
        faq!.querySelectorAll('[aria-expanded]').length,
        'no accordion triggers inside #faq — is <FAQ> still rendered?'
      ).toBeGreaterThan(0);
    });

    it('offers the primary signup call to action', () => {
      render(<LandingPage />);

      const signupLinks = screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('href') === '/signup');

      expect(signupLinks.length).toBeGreaterThan(0);
    });

    it('is not the About page', () => {
      render(<LandingPage />);

      // The specific confusion that shipped. These are `/about`'s own rendered
      // section headings — the landing page must render none of them.
      //
      // They are asserted against the *rendered* output on purpose. The first
      // draft of this test used `aboutDescription` ("Learn about Sunrise."),
      // which feeds metadata and is never rendered by either page, so the
      // assertion held against the clobbered page too — a test that could not
      // fail, guarding the one defect this file exists for.
      for (const heading of ['About Sunrise', 'Design Principles', 'Technology Stack']) {
        expect(
          screen.queryByText(heading),
          `landing page renders /about's "${heading}"`
        ).toBeNull();
      }
    });
  });
});
