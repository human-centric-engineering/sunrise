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

    it('does not name the brand in any title the layout template will append to', () => {
      // `(public)/layout.tsx` declares `template: '%s - ${BRAND.name}'`, and
      // Next applies it to the openGraph/twitter titles too — so a title
      // naming the brand renders it twice. Declaring none is how this page
      // opts into the template for all three.
      expect(metadata.openGraph?.title).toBeUndefined();
      expect(metadata.twitter?.title).toBeUndefined();
    });

    it('describes itself from the BRAND seam rather than a hardcoded blurb', () => {
      expect(metadata.description).toBe(BRAND.description);
    });

    it('declares the website OpenGraph type a landing page needs', () => {
      expect(metadata.openGraph?.type).toBe('website');
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
      render(<LandingPage />);

      expect(screen.getByText('Simple, Transparent Pricing')).toBeInTheDocument();
      expect(screen.getByText('Frequently Asked Questions')).toBeInTheDocument();
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
