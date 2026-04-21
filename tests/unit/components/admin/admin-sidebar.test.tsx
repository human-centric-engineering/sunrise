/**
 * AdminSidebar Component Tests
 *
 * Covers section rendering, orchestration nav items, active-state
 * highlighting (including the `exact` flag on Dashboard), and the
 * collapse toggle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AdminSidebar } from '@/components/admin/admin-sidebar';

const pathnameMock = vi.fn(() => '/admin/overview');

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));

describe('AdminSidebar', () => {
  beforeEach(() => {
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue('/admin/overview');
  });

  it('renders all four top-level sections', () => {
    render(<AdminSidebar />);
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Management')).toBeInTheDocument();
    expect(screen.getByText('AI Orchestration')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('renders all 9 orchestration items with correct hrefs', () => {
    render(<AdminSidebar />);

    const expected: Array<{ label: string; href: string }> = [
      { label: 'Dashboard', href: '/admin/orchestration' },
      { label: 'Agents', href: '/admin/orchestration/agents' },
      { label: 'Capabilities', href: '/admin/orchestration/capabilities' },
      { label: 'Providers', href: '/admin/orchestration/providers' },
      { label: 'Workflows', href: '/admin/orchestration/workflows' },
      { label: 'Knowledge Base', href: '/admin/orchestration/knowledge' },
      { label: 'Costs & Budget', href: '/admin/orchestration/costs' },
      { label: 'Learning', href: '/admin/orchestration/learn' },
      { label: 'Evaluations', href: '/admin/orchestration/evaluations' },
    ];

    for (const { href } of expected) {
      const links = screen.getAllByRole('link');
      const link = links.find((el) => el.getAttribute('href') === href);
      expect(link, `link for ${href} not found`).toBeDefined();
    }
  });

  it('highlights the Agents item when on a nested agents route', () => {
    pathnameMock.mockReturnValue('/admin/orchestration/agents/abc123');
    render(<AdminSidebar />);

    const agentsLink = screen.getByRole('link', { name: /^agents$/i });
    expect(agentsLink).toHaveAttribute('aria-current', 'page');

    // The orchestration "Dashboard" item must NOT be active on a nested route
    // because it has `exact: true`.
    const dashboardLinks = screen.getAllByRole('link', { name: /^dashboard$/i });
    const orchestrationDashboard = dashboardLinks.find(
      (el) => el.getAttribute('href') === '/admin/orchestration'
    );
    expect(orchestrationDashboard).toBeDefined();
    expect(orchestrationDashboard).not.toHaveAttribute('aria-current', 'page');
  });

  it('highlights the orchestration Dashboard on exact match', () => {
    pathnameMock.mockReturnValue('/admin/orchestration');
    render(<AdminSidebar />);

    const dashboardLinks = screen.getAllByRole('link', { name: /^dashboard$/i });
    const orchestrationDashboard = dashboardLinks.find(
      (el) => el.getAttribute('href') === '/admin/orchestration'
    );
    expect(orchestrationDashboard).toHaveAttribute('aria-current', 'page');
  });

  it('collapse toggle hides labels but keeps icons', async () => {
    const user = userEvent.setup();
    render(<AdminSidebar />);

    expect(screen.getByText('AI Orchestration')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }));

    // Section headings hidden when collapsed
    expect(screen.queryByText('AI Orchestration')).not.toBeInTheDocument();

    // Top-level links are still present (so icons + hrefs remain navigable)
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute(
      'href',
      '/admin/orchestration/settings'
    );
  });
});
