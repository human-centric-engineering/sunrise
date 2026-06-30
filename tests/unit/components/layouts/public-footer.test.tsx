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
 * @see components/layouts/public-footer.tsx · lib/app/public-nav.ts
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
    expect(screen.getByText(/All rights reserved/)).toHaveTextContent('Sunrise');
    // Cookie Preferences control is present out of the box.
    expect(screen.getByRole('button', { name: 'Cookie Preferences' })).toBeInTheDocument();
  });

  it('attributes the copyright to NEXT_PUBLIC_LEGAL_NAME, not the product name (#363)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APP_NAME', 'ConQuest');
    vi.stubEnv('NEXT_PUBLIC_LEGAL_NAME', 'All Too Human Ltd');
    const { PublicFooter } = await import('@/components/layouts/public-footer');
    render(React.createElement(PublicFooter));

    const copyright = screen.getByText(/All rights reserved/);
    expect(copyright).toHaveTextContent('All Too Human Ltd');
    // The copyright line names the legal entity, NOT the product.
    expect(copyright).not.toHaveTextContent('ConQuest');
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
