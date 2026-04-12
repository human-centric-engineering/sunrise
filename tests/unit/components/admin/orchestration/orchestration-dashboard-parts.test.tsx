/**
 * Orchestration Dashboard Component Tests
 *
 * Covers the dashboard's sub-components in lieu of a full server-component
 * integration test:
 *   - OrchestrationStatsCards: null → em-dash, number formatting
 *   - BudgetAlertsBanner: renders null on empty, rows link correctly
 *   - RecentActivityList: empty state + row rendering
 *   - QuickActions: 4 expected hrefs
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { OrchestrationStatsCards } from '@/components/admin/orchestration/orchestration-stats-cards';
import { BudgetAlertsBanner } from '@/components/admin/orchestration/budget-alerts-banner';
import {
  RecentActivityList,
  type RecentActivityItem,
} from '@/components/admin/orchestration/recent-activity-list';
import { QuickActions } from '@/components/admin/orchestration/quick-actions';

describe('OrchestrationStatsCards', () => {
  it('renders em-dashes when values are null', () => {
    render(
      <OrchestrationStatsCards
        agentsCount={null}
        workflowsCount={null}
        todayCostUsd={null}
        conversationsCount={null}
      />
    );
    // Four cards, each showing "—"
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('formats numbers with locale separators and cost as USD', () => {
    render(
      <OrchestrationStatsCards
        agentsCount={12}
        workflowsCount={3}
        todayCostUsd={4.2}
        conversationsCount={1234}
      />
    );
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('$4.20')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
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

describe('RecentActivityList', () => {
  it('shows an empty state when items is null', () => {
    render(<RecentActivityList items={null} />);
    expect(screen.getByText(/no recent conversations or executions/i)).toBeInTheDocument();
  });

  it('shows an empty state when items is empty', () => {
    render(<RecentActivityList items={[]} />);
    expect(screen.getByText(/no recent conversations or executions/i)).toBeInTheDocument();
  });

  it('renders conversation and execution rows up to the limit', () => {
    const items: RecentActivityItem[] = [
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
    ];

    render(<RecentActivityList items={items} />);

    expect(screen.getByRole('link', { name: 'My chat' })).toHaveAttribute(
      'href',
      '/admin/orchestration/conversations/c1'
    );
    expect(screen.getByRole('link', { name: /Execution e1xxxxxx/i })).toHaveAttribute(
      'href',
      '/admin/orchestration/executions/e1'
    );
    expect(screen.getByText('running')).toBeInTheDocument();
  });
});

describe('QuickActions', () => {
  it('renders the four expected action links', () => {
    render(<QuickActions />);

    // Assert at least the four standard orchestration deep links exist.
    const expectedHrefs = [
      '/admin/orchestration/agents/new',
      '/admin/orchestration/workflows/new',
      '/admin/orchestration/knowledge',
      '/admin/orchestration/conversations',
    ];

    for (const href of expectedHrefs) {
      const links = screen.getAllByRole('link');
      const match = links.find((el) => el.getAttribute('href') === href);
      expect(match, `missing link ${href}`).toBeDefined();
    }
  });
});
