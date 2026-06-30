/**
 * ProtectedFooter copyright attribution (issue #363)
 *
 * The authenticated footer's copyright line attributes to `BRAND.legalName`
 * (the legal entity), not the product name — same seam as the public footer.
 * `BRAND` resolves env at module load, so the legal-name case stubs the env and
 * re-imports the component fresh.
 *
 * @see components/layouts/protected-footer.tsx · lib/brand.ts
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

  it('attributes the copyright to NEXT_PUBLIC_LEGAL_NAME, not the product name (#363)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APP_NAME', 'ConQuest');
    vi.stubEnv('NEXT_PUBLIC_LEGAL_NAME', 'All Too Human Ltd');
    const { ProtectedFooter } = await import('@/components/layouts/protected-footer');
    render(React.createElement(ProtectedFooter));

    const copyright = screen.getByText(/©/);
    expect(copyright).toHaveTextContent('All Too Human Ltd');
    expect(copyright).not.toHaveTextContent('ConQuest');
  });
});
