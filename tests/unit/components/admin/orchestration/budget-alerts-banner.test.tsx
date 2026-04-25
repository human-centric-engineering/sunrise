/**
 * Tests: BudgetAlertsBanner
 *
 * @see components/admin/orchestration/budget-alerts-banner.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BudgetAlertsBanner } from '@/components/admin/orchestration/budget-alerts-banner';
import type { BudgetAlert } from '@/lib/orchestration/llm/cost-reports';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAlert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
  return {
    agentId: 'agent-1',
    slug: 'test-agent',
    name: 'Test Agent',
    spent: 80,
    monthlyBudgetUsd: 100,
    utilisation: 0.8,
    severity: 'warning' as const,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('BudgetAlertsBanner', () => {
  it('renders nothing when alerts is null', () => {
    const { container } = render(<BudgetAlertsBanner alerts={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when alerts is an empty array', () => {
    const { container } = render(<BudgetAlertsBanner alerts={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders alert rows for each agent', () => {
    const alerts = [
      makeAlert({ agentId: 'a1', name: 'Agent A', utilisation: 0.85 }),
      makeAlert({ agentId: 'a2', name: 'Agent B', utilisation: 1.1, severity: 'critical' }),
    ];
    render(<BudgetAlertsBanner alerts={alerts} />);

    expect(screen.getByText('Agent A')).toBeInTheDocument();
    expect(screen.getByText('Agent B')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('110%')).toBeInTheDocument();
  });

  it('links each agent row to the agent detail page', () => {
    const alerts = [makeAlert({ agentId: 'agent-42', name: 'My Agent' })];
    render(<BudgetAlertsBanner alerts={alerts} />);

    const link = screen.getByRole('link', { name: 'My Agent' });
    expect(link).toHaveAttribute('href', '/admin/orchestration/agents/agent-42');
  });

  it('displays formatted spend and budget using shared formatUsd', () => {
    const alerts = [makeAlert({ spent: 0.0042, monthlyBudgetUsd: 10 })];
    render(<BudgetAlertsBanner alerts={alerts} />);

    // formatUsd: 0.0042 < $1 → 4 decimals ($0.0042); 10 ≥ $1 → 2 decimals ($10.00)
    expect(screen.getByText(/\$0\.0042/)).toBeInTheDocument();
    expect(screen.getByText(/\$10\.00/)).toBeInTheDocument();
  });

  it('renders the banner card with correct test id', () => {
    const alerts = [makeAlert()];
    render(<BudgetAlertsBanner alerts={alerts} />);

    expect(screen.getByTestId('budget-alerts-banner')).toBeInTheDocument();
  });

  it('uses destructive badge variant for critical severity', () => {
    const alerts = [makeAlert({ severity: 'critical', utilisation: 1.2 })];
    render(<BudgetAlertsBanner alerts={alerts} />);

    const badge = screen.getByText('120%');
    expect(badge.className).toMatch(/destructive/);
  });

  it('uses amber styling for warning severity', () => {
    const alerts = [makeAlert({ severity: 'warning', utilisation: 0.85 })];
    render(<BudgetAlertsBanner alerts={alerts} />);

    const badge = screen.getByText('85%');
    expect(badge.className).toMatch(/amber/);
  });
});
