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
 * So the assertions here are deliberately about **identity**, not liveness. A
 * "renders without crashing" test would have passed against the About page too,
 * which is the whole failure. Each block below names something only the landing
 * page has.
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

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import LandingPage, { metadata } from '@/app/(public)/page';
import { BRAND } from '@/lib/brand';

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

    it('describes itself from the BRAND seam rather than a hardcoded blurb', () => {
      expect(metadata.description).toBe(BRAND.description);
    });

    it('declares the website OpenGraph type a landing page needs', () => {
      // `OpenGraph` is a discriminated union and `type` lives only on its
      // members, not the base — reading it directly does not type-check.
      const openGraph = metadata.openGraph;
      expect(openGraph && 'type' in openGraph ? openGraph.type : undefined).toBe('website');
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
