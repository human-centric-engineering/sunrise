// @vitest-environment happy-dom

/**
 * AdminHeader (§111 t-813): names the org being acted in, at `multi` only.
 *
 * @see components/admin/admin-header.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AdminHeader } from '@/components/admin/admin-header';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/members',
}));

vi.mock('@/components/layouts/header-actions', () => ({
  HeaderActions: () => <div data-testid="header-actions" />,
}));

describe('AdminHeader', () => {
  it('names the org being acted in when orgName is given', () => {
    render(<AdminHeader orgName="Acme Ltd" />);

    const note = screen.getByText(/Acting in/);
    expect(note).toHaveTextContent('Acting in Acme Ltd');
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByTestId('header-actions')).toBeInTheDocument();
  });

  it('shows no acting-in text without orgName', () => {
    render(<AdminHeader />);

    expect(screen.queryByText(/Acting in/)).not.toBeInTheDocument();
    expect(screen.getByTestId('header-actions')).toBeInTheDocument();
  });

  it('titles the page from the Members breadcrumb segment', () => {
    render(<AdminHeader />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Members');
  });
});
