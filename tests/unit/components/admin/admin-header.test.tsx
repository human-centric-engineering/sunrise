// @vitest-environment happy-dom

/**
 * AdminHeader (§111 t-813): names the org being acted in, at `multi` only.
 *
 * @see components/admin/admin-header.tsx
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AdminHeader } from '@/components/admin/admin-header';
import { ORG_TIER_ADMIN_PAGES } from '@/lib/auth/admin-tier';

const nav = vi.hoisted(() => ({ pathname: '/admin/members' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
}));

vi.mock('@/components/layouts/header-actions', () => ({
  HeaderActions: () => <div data-testid="header-actions" />,
}));

describe('AdminHeader', () => {
  beforeEach(() => {
    nav.pathname = '/admin/members';
  });

  it('names the org being acted in when orgName is given', () => {
    render(<AdminHeader orgTierPages={ORG_TIER_ADMIN_PAGES} orgName="Acme Ltd" />);

    const note = screen.getByText(/Acting in/);
    expect(note).toHaveTextContent('Acting in Acme Ltd');
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByTestId('header-actions')).toBeInTheDocument();
  });

  it('names no org on a platform page, which is install-wide', () => {
    nav.pathname = '/admin/users';
    render(<AdminHeader orgTierPages={ORG_TIER_ADMIN_PAGES} orgName="Acme Ltd" />);

    expect(screen.queryByText(/Acting in/)).not.toBeInTheDocument();
    expect(screen.getByTestId('header-actions')).toBeInTheDocument();
  });

  it('names the org on a fork’s page when the list the layout handed down has it (t-817)', () => {
    nav.pathname = '/admin/reports';
    render(
      <AdminHeader orgName="Acme Ltd" orgTierPages={[...ORG_TIER_ADMIN_PAGES, '/admin/reports']} />
    );

    expect(screen.getByText(/Acting in/)).toHaveTextContent('Acting in Acme Ltd');
  });

  it('shows no acting-in text without orgName', () => {
    render(<AdminHeader orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    expect(screen.queryByText(/Acting in/)).not.toBeInTheDocument();
    expect(screen.getByTestId('header-actions')).toBeInTheDocument();
  });

  it('titles the page from the Members breadcrumb segment', () => {
    render(<AdminHeader orgTierPages={ORG_TIER_ADMIN_PAGES} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Members');
  });

  it('links each breadcrumb but the last, and labels an unknown segment by its name', () => {
    nav.pathname = '/admin/orchestration';
    render(<AdminHeader orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin');
    expect(screen.queryByRole('link', { name: 'orchestration' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Admin');
  });

  it('prefers an explicit title and shows a description', () => {
    render(
      <AdminHeader
        orgTierPages={ORG_TIER_ADMIN_PAGES}
        title="Custom title"
        description="What this page is for"
      />
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Custom title');
    expect(screen.getByText('What this page is for')).toBeInTheDocument();
  });
});
