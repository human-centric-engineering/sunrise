/**
 * Orchestration Dashboard Component Tests
 *
 * Covers the dashboard's sub-components:
 *   - DashboardStatsCards: null → em-dash, number formatting, clickable links
 *   - BudgetAlertsBanner: renders null on empty, rows link correctly
 *   - DashboardActivityFeed: empty state + row rendering + error items
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DashboardStatsCards } from '@/components/admin/orchestration/dashboard-stats-cards';
import { BudgetAlertsBanner } from '@/components/admin/orchestration/budget-alerts-banner';
import {
  DashboardActivityFeed,
  type ActivityFeedItem,
} from '@/components/admin/orchestration/dashboard-activity-feed';

describe('DashboardStatsCards', () => {
  it('renders em-dashes when values are null', () => {
    render(
      <DashboardStatsCards
        agentsCount={null}
        todayCostUsd={null}
        todayRequests={null}
        errorRate={null}
      />
    );
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('formats numbers and cost correctly', () => {
    render(
      <DashboardStatsCards
        agentsCount={12}
        todayCostUsd={4.2}
        todayRequests={847}
        errorRate={0.032}
      />
    );
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('$4.20')).toBeInTheDocument();
    expect(screen.getByText('847')).toBeInTheDocument();
    expect(screen.getByText('3.2%')).toBeInTheDocument();
  });

  it('renders four clickable links to detail pages', () => {
    render(
      <DashboardStatsCards agentsCount={1} todayCostUsd={1} todayRequests={1} errorRate={0.01} />
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);

    const hrefs = links.map((el) => el.getAttribute('href'));
    expect(hrefs).toContain('/admin/orchestration/agents');
    expect(hrefs).toContain('/admin/orchestration/costs');
    expect(hrefs).toContain('/admin/orchestration/conversations');
    expect(hrefs).toContain('/admin/orchestration/analytics');
  });
});

describe('BudgetAlertsBanner', () => {
  it('renders nothing when alerts is null', () => {
    const { container } = render(<BudgetAlertsBanner alerts={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when alerts is empty', () => {
    const { container } = render(<BudgetAlertsBanner alerts={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders alert rows with correct agent links and percentages', () => {
    render(
      <BudgetAlertsBanner
        alerts={[
          {
            agentId: 'agent-1',
            slug: 'agent-one',
            name: 'Agent One',
            monthlyBudgetUsd: 100,
            spent: 85,
            utilisation: 0.85,
            severity: 'warning',
          },
          {
            agentId: 'agent-2',
            slug: 'agent-two',
            name: 'Agent Two',
            monthlyBudgetUsd: 100,
            spent: 102,
            utilisation: 1.02,
            severity: 'critical',
          },
        ]}
      />
    );

    const link1 = screen.getByRole('link', { name: 'Agent One' });
    expect(link1).toHaveAttribute('href', '/admin/orchestration/agents/agent-1');
    const link2 = screen.getByRole('link', { name: 'Agent Two' });
    expect(link2).toHaveAttribute('href', '/admin/orchestration/agents/agent-2');

    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('102%')).toBeInTheDocument();
  });
});

describe('DashboardActivityFeed', () => {
  it('shows an empty state when items is null', () => {
    render(<DashboardActivityFeed items={null} />);
    expect(screen.getByText(/no recent activity/i)).toBeInTheDocument();
  });

  it('shows an empty state when items is empty', () => {
    render(<DashboardActivityFeed items={[]} />);
    expect(screen.getByText(/no recent activity/i)).toBeInTheDocument();
  });

  it('renders conversation, execution, and error rows', () => {
    const items: ActivityFeedItem[] = [
      {
        kind: 'conversation',
        id: 'c1',
        title: 'My chat',
        timestamp: new Date('2026-04-01T12:00:00Z').toISOString(),
        href: '/admin/orchestration/conversations/c1',
      },
      {
        kind: 'execution',
        id: 'e1',
        title: 'Execution e1xxxxxx',
        subtitle: 'running',
        timestamp: new Date('2026-04-02T12:00:00Z').toISOString(),
        href: '/admin/orchestration/executions/e1',
      },
      {
        kind: 'error',
        id: 'err1',
        title: 'Error err1xxxx',
        subtitle: 'Timeout',
        timestamp: new Date('2026-04-03T12:00:00Z').toISOString(),
        href: '/admin/orchestration/executions/err1',
      },
    ];

    render(<DashboardActivityFeed items={items} />);

    expect(screen.getByRole('link', { name: 'My chat' })).toHaveAttribute(
      'href',
      '/admin/orchestration/conversations/c1'
    );
    expect(screen.getByRole('link', { name: /Execution e1xxxxxx/i })).toHaveAttribute(
      'href',
      '/admin/orchestration/executions/e1'
    );
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('Timeout')).toBeInTheDocument();
  });
});
