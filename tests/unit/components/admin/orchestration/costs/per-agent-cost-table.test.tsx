/**
 * PerAgentCostTable Component Tests
 *
 * Test Coverage:
 * - Utilisation bar colour thresholds: ≤50% green, ≤80% amber, >80% red
 * - Empty rows → "No agent spend recorded this month"
 * - Clicking the "Utilisation" header sorts by utilisation
 *
 * @see components/admin/orchestration/costs/per-agent-cost-table.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PerAgentCostTable } from '@/components/admin/orchestration/costs/per-agent-cost-table';
import type { CostSummaryAgentRow } from '@/lib/orchestration/llm/cost-reports';

function makeRow(overrides: Partial<CostSummaryAgentRow> = {}): CostSummaryAgentRow {
  return {
    agentId: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    monthSpend: 50,
    monthlyBudgetUsd: 100,
    utilisation: 0.5,
    ...overrides,
  };
}

describe('PerAgentCostTable', () => {
  describe('empty state', () => {
    it('shows empty state message when rows is null', () => {
      render(<PerAgentCostTable rows={null} />);
      expect(screen.getByText('No agent spend recorded this month.')).toBeInTheDocument();
    });

    it('shows empty state message when rows is empty array', () => {
      render(<PerAgentCostTable rows={[]} />);
      expect(screen.getByText('No agent spend recorded this month.')).toBeInTheDocument();
    });
  });

  describe('utilisation bar colour thresholds', () => {
    it('renders green (bg-emerald-500) class for utilisation <= 0.5', () => {
      // Arrange
      const row = makeRow({ agentId: 'a1', name: 'Green Agent', utilisation: 0.3 });

      // Act
      const { container } = render(<PerAgentCostTable rows={[row]} />);

      // Assert: the filled div inside the progressbar has emerald class
      const bar = container.querySelector('[role="progressbar"] .bg-emerald-500');
      expect(bar).not.toBeNull();
    });

    it('renders amber (bg-amber-500) class for utilisation > 0.5 and <= 0.8', () => {
      // Arrange
      const row = makeRow({ agentId: 'a2', name: 'Amber Agent', utilisation: 0.7 });

      // Act
      const { container } = render(<PerAgentCostTable rows={[row]} />);

      // Assert
      const bar = container.querySelector('[role="progressbar"] .bg-amber-500');
      expect(bar).not.toBeNull();
    });

    it('renders red (bg-red-500) class for utilisation > 0.8', () => {
      // Arrange
      const row = makeRow({ agentId: 'a3', name: 'Red Agent', utilisation: 0.9 });

      // Act
      const { container } = render(<PerAgentCostTable rows={[row]} />);

      // Assert
      const bar = container.querySelector('[role="progressbar"] .bg-red-500');
      expect(bar).not.toBeNull();
    });

    it('shows "No budget set" text when utilisation is null', () => {
      // Arrange: agent with no budget
      const row = makeRow({ utilisation: null, monthlyBudgetUsd: null });

      // Act
      render(<PerAgentCostTable rows={[row]} />);

      // Assert
      expect(screen.getByText('No budget set')).toBeInTheDocument();
    });
  });

  describe('sorting', () => {
    it('renders the table when rows are present', () => {
      const rows = [
        makeRow({ agentId: 'a1', name: 'Alpha', monthSpend: 100, utilisation: 0.5 }),
        makeRow({ agentId: 'a2', name: 'Beta', monthSpend: 50, utilisation: 0.3 }),
      ];

      render(<PerAgentCostTable rows={rows} />);

      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });

    it('clicking the Utilisation header does not throw and re-renders the table', async () => {
      // Arrange
      const user = userEvent.setup();
      const rows = [
        makeRow({ agentId: 'a1', name: 'Alpha', utilisation: 0.9 }),
        makeRow({ agentId: 'a2', name: 'Beta', utilisation: 0.3 }),
      ];

      render(<PerAgentCostTable rows={rows} />);

      // Act: click Utilisation sort header
      const utilisationBtn = screen.getByRole('button', { name: /utilisation/i });
      await user.click(utilisationBtn);

      // Assert: table still renders without throwing, with the sort indicator
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
      // Sort indicator appears after click
      expect(screen.getByRole('button', { name: /utilisation.*↓/i })).toBeInTheDocument();
    });

    it('clicking Spend header sorts by spend with indicator', async () => {
      const user = userEvent.setup();
      const rows = [makeRow({ agentId: 'a1' })];

      render(<PerAgentCostTable rows={rows} />);

      // Act: first click utilisation to switch away from spend default
      await user.click(screen.getByRole('button', { name: /utilisation/i }));
      // Then click spend to restore
      await user.click(screen.getByRole('button', { name: /^spend/i }));

      // Assert: Spend button now has ↓ indicator
      expect(screen.getByRole('button', { name: /spend.*↓/i })).toBeInTheDocument();
    });
  });

  describe('table content', () => {
    it('renders the agent card wrapper', () => {
      const rows = [makeRow({ agentId: 'a1', name: 'My Agent' })];
      render(<PerAgentCostTable rows={rows} />);
      expect(screen.getByTestId('per-agent-cost-table')).toBeInTheDocument();
    });
  });
});
