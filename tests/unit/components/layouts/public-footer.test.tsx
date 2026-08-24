// @vitest-environment happy-dom

/**
 * PublicFooter default-vs-override + non-overridable consent control (issue #347)
 *
 * The footer renders `footerNavItems` / `footerLegalItems` from the fork-owned
 * `lib/app/public-nav.ts` when non-null, else the platform defaults — overrides
 * *replace* the defaults wholesale. The **Cookie Preferences** control is always
 * rendered by the platform regardless of the legal override (consent is a legal
 * requirement, not fork copy). Lists resolve at module load, so override cases
 * stub the scaffold via `vi.doMock` and re-import fresh.
 *
 * The attribution line resolves through `lib/app/footer.ts` (#561) — `null`
 * for the platform default, a string to replace it, `false` to omit it.
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — filling `footerCopyright` or the footer nav lists fails cases here
 * ---------------------------------------------------------------------------
 * The `afterEach` only `doUnmock`s the seams, so the default-case tests below
 * render whatever `lib/app/footer.ts` and `lib/app/public-nav.ts` export. Pin
 * your own values rather than deleting the cases — the assertion that Cookie
 * Preferences survives a `false` seam is the one that must not rot. See #636.
 *
 * @see components/layouts/public-footer.tsx · lib/app/public-nav.ts · lib/app/footer.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';

const openPreferences = vi.fn();

// useConsent supplies the Cookie Preferences click handler.
vi.mock('@/lib/consent', () => ({
  useConsent: () => ({ openPreferences }),
}));

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/app/public-nav');
  vi.doUnmock('@/lib/app/footer');
  vi.unstubAllEnvs();
  openPreferences.mockClear();
});

describe('PublicFooter', () => {
  it('renders the platform default nav, legal links, and copyright', async () => {
    vi.resetModules();
    const { PublicFooter } = await import('@/components/layouts/public-footer');
    render(React.createElement(PublicFooter));

    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about');
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/privacy'
    );
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      '/terms'
    );
    expect(screen.getByText(/^©/)).toHaveTextContent('Sunrise');
    // Cookie Preferences control is present out of the box.
    expect(screen.getByRole('button', { name: 'Cookie Preferences' })).toBeInTheDocument();
  });

  // Fork-brand cases live in tests/unit/brand-fork-surfaces.test.tsx, which
  // mocks the seam HOISTED. Driving a brand from here needs doMock +
  // resetModules + re-import, which races the module graph and failed on CI.

  // ---- footerCopyright seam (#561) --------------------------------------

  it('renders no attribution line when the seam is false', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: false }));
    const { PublicFooter } = await import('@/components/layouts/public-footer');
    render(React.createElement(PublicFooter));

    expect(screen.queryByText(/^©/)).not.toBeInTheDocument();
    // The rest of the footer is untouched — and Cookie Preferences in
    // particular is NOT fork-overridable, so it must survive.
    expect(screen.getByRole('link', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cookie Preferences' })).toBeInTheDocument();
  });

  it('renders a fork string verbatim, with no year interpolated', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: 'An All Too Human production' }));
    const { PublicFooter } = await import('@/components/layouts/public-footer');
    render(React.createElement(PublicFooter));

    expect(screen.getByText('An All Too Human production')).toBeInTheDocument();
    expect(screen.queryByText(/^©/)).not.toBeInTheDocument();
  });

  it('does not render the attribution on a row of its own (#561)', async () => {
    // The regression this guards: a dedicated centred row cost ~44px, which is
    // the whole complaint. Assert it shares the flex row with the nav clusters
    // rather than sitting in a sibling container beneath them.
    vi.resetModules();
    const { PublicFooter } = await import('@/components/layouts/public-footer');
    const { container } = render(React.createElement(PublicFooter));

    const copyright = screen.getByText(/^©/);
    const navAbout = screen.getByRole('link', { name: 'About' });
    expect(copyright.parentElement).toBe(navAbout.closest('nav')?.parentElement);
    expect(container.querySelector('.mt-6.text-center')).toBeNull();
  });

  it('replaces nav and legal clusters wholesale with override lists', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/public-nav', () => ({
      publicNavItems: null,
      footerNavItems: [{ href: '/pricing', label: 'Pricing' }],
      footerLegalItems: [{ href: '/eula', label: 'EULA' }],
    }));

    const { PublicFooter } = await import('@/components/layouts/public-footer');
    render(React.createElement(PublicFooter));

    expect(screen.getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing');
    expect(screen.getByRole('link', { name: 'EULA' })).toHaveAttribute('href', '/eula');
    // Defaults are gone.
    expect(screen.queryByRole('link', { name: 'About' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Privacy Policy' })).toBeNull();
  });

  it('always renders the Cookie Preferences control even when the legal override omits it', async () => {
    vi.resetModules();
    // A legal override with NO consent link — the control must still appear.
    vi.doMock('@/lib/app/public-nav', () => ({
      publicNavItems: null,
      footerNavItems: null,
      footerLegalItems: [{ href: '/eula', label: 'EULA' }],
    }));

    const { PublicFooter } = await import('@/components/layouts/public-footer');
    render(React.createElement(PublicFooter));

    expect(screen.getByRole('button', { name: 'Cookie Preferences' })).toBeInTheDocument();
  });
});
