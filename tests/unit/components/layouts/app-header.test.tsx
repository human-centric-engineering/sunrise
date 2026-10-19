// @vitest-environment happy-dom

/**
 * AppHeader — brand, navigation slot and actions (issue #862)
 *
 * The header is one row. Before #862 nothing in it could shrink, so a long
 * brand or a fork's longer nav pushed the actions off a small screen. The
 * brand now truncates and the actions hold their size; happy-dom applies no
 * CSS, so the layout cases assert the classes that carry that behaviour.
 *
 * @see components/layouts/app-header.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppHeader } from '@/components/layouts/app-header';
import { BRAND } from '@/lib/brand';

vi.mock('@/components/layouts/header-actions', () => ({
  HeaderActions: () => <div data-testid="header-actions" />,
}));

describe('AppHeader', () => {
  it('links the brand to logoHref and renders the navigation slot and actions', () => {
    render(<AppHeader logoHref="/dashboard" logoText="Acme" navigation={<nav>Nav slot</nav>} />);

    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('navigation')).toHaveTextContent('Nav slot');
    expect(screen.getByTestId('header-actions')).toBeInTheDocument();
  });

  it('defaults the brand link to the root and its text to the BrandMark', () => {
    render(<AppHeader />);

    expect(screen.getByRole('link', { name: BRAND.name })).toHaveAttribute('href', '/');
  });

  it('lets a long brand truncate instead of pushing the actions off-screen', () => {
    render(<AppHeader logoText="A very long brand name that will not fit on a phone" />);

    const brand = screen.getByRole('link', { name: /very long brand/ });
    expect(brand).toHaveClass('min-w-0', 'truncate');
    expect(brand.parentElement).toHaveClass('min-w-0');
    expect(screen.getByTestId('header-actions').parentElement).toHaveClass('shrink-0');
  });
});
