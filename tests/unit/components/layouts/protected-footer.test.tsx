// @vitest-environment happy-dom

/**
 * ProtectedFooter copyright attribution (issue #363)
 *
 * The authenticated footer's copyright line attributes to `BRAND.legalName`
 * (the legal entity), not the product name — same seam as the public footer.
 * `BRAND` resolves env at module load, so the legal-name case stubs the env and
 * re-imports the component fresh.
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — filling `footerCopyright` is EXPECTED to fail cases here
 * ---------------------------------------------------------------------------
 * The `afterEach` only `doUnmock`s `lib/app/footer.ts`, so the default-case
 * tests below render whatever it exports. Pin your own value rather than
 * deleting them. See #636.
 *
 * @see components/layouts/protected-footer.tsx · lib/brand.ts · lib/app/footer.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';

const openPreferences = vi.fn();

vi.mock('@/lib/consent', () => ({
  useConsent: () => ({ openPreferences }),
}));

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/app/footer');
  vi.unstubAllEnvs();
  openPreferences.mockClear();
});

describe('ProtectedFooter', () => {
  it('renders the default copyright with the platform name when unset', async () => {
    vi.resetModules();
    const { ProtectedFooter } = await import('@/components/layouts/protected-footer');
    render(React.createElement(ProtectedFooter));

    expect(screen.getByText(/©/)).toHaveTextContent('Sunrise');
  });

  // Fork-brand cases live in tests/unit/brand-fork-surfaces.test.tsx, which
  // mocks the seam HOISTED. Driving a brand from here needs doMock +
  // resetModules + re-import, which races the module graph and failed on CI.

  // ---- footerCopyright seam (#561) --------------------------------------
  // The seam exists on BOTH footers precisely so they cannot drift apart on
  // what the attribution says — they already had, before #561: this one
  // rendered "© {year} {legalName}" inline while PublicFooter rendered
  // "…All rights reserved." on a dedicated centred row.

  it('renders no attribution line when the seam is false', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: false }));
    const { ProtectedFooter } = await import('@/components/layouts/protected-footer');
    render(React.createElement(ProtectedFooter));

    expect(screen.queryByText(/©/)).not.toBeInTheDocument();
    // Cookie Preferences is not fork-overridable and must survive.
    expect(screen.getByRole('button', { name: 'Cookie Preferences' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Help & Support' })).toBeInTheDocument();
  });

  it('renders a fork string verbatim', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/footer', () => ({ footerCopyright: 'An All Too Human production' }));
    const { ProtectedFooter } = await import('@/components/layouts/protected-footer');
    render(React.createElement(ProtectedFooter));

    expect(screen.getByText('An All Too Human production')).toBeInTheDocument();
    expect(screen.queryByText(/©/)).not.toBeInTheDocument();
  });
});
