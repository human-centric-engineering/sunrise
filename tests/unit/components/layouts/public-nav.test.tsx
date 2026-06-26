/**
 * PublicNav default-vs-override (issue #347)
 *
 * The header marketing nav renders `publicNavItems` from the fork-owned
 * `lib/app/public-nav.ts` when non-null, else `DEFAULT_PUBLIC_NAV`. The override
 * list *replaces* the default wholesale. `navItems` is resolved at module load,
 * so the override case stubs the scaffold via `vi.doMock` and re-imports fresh.
 *
 * `usePathname` is globally mocked to '/' (tests/setup.ts), so Home is active.
 *
 * @see components/layouts/public-nav.tsx · lib/app/public-nav.ts · lib/public-nav/types.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/app/public-nav');
});

describe('PublicNav', () => {
  it('renders the platform default links when no override is set', async () => {
    vi.resetModules();
    const { PublicNav } = await import('@/components/layouts/public-nav');
    render(React.createElement(PublicNav));

    expect(screen.getByRole('link', { name: /home/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /about/i })).toHaveAttribute('href', '/about');
    expect(screen.getByRole('link', { name: /contact/i })).toHaveAttribute('href', '/contact');
    // Home is the active page (pathname '/').
    expect(screen.getByRole('link', { name: /home/i })).toHaveAttribute('aria-current', 'page');
  });

  it('replaces the default wholesale with a non-null override list', async () => {
    vi.resetModules();
    vi.doMock('@/lib/app/public-nav', () => ({
      publicNavItems: [
        { href: '/pricing', label: 'Pricing' },
        { href: '/docs', label: 'Docs' },
      ],
      footerNavItems: null,
      footerLegalItems: null,
    }));

    const { PublicNav } = await import('@/components/layouts/public-nav');
    render(React.createElement(PublicNav));

    expect(screen.getByRole('link', { name: /pricing/i })).toHaveAttribute('href', '/pricing');
    expect(screen.getByRole('link', { name: /docs/i })).toHaveAttribute('href', '/docs');
    // Default links are gone — replacement, not append.
    expect(screen.queryByRole('link', { name: /about/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /contact/i })).toBeNull();
  });
});
