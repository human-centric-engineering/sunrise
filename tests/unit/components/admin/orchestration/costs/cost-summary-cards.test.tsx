/**
 * CostSummaryCards Component Tests
 *
 * Test Coverage:
 * - Null summary renders em-dash (—) in all four cards
 * - Projected month calculation: month / daysElapsed * daysInMonth
 * - Non-null summary renders formatted USD values
 *
 * @see components/admin/orchestration/costs/cost-summary-cards.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CostSummaryCards } from '@/components/admin/orchestration/costs/cost-summary-cards';
import type { CostSummary } from '@/lib/orchestration/llm/cost-reports';

// Minimal summary fixture
function makeSummary(monthSpend: number): CostSummary {
  return {
    totals: { today: 1.5, week: 7.25, month: monthSpend },
    byAgent: [],
    byModel: [],
    trend: [],
    localSavings: null,
  };
}

describe('CostSummaryCards', () => {
  describe('null summary', () => {
    it('renders four cards each displaying — when summary is null', () => {
      // Arrange + Act
      render(<CostSummaryCards summary={null} />);

      // Assert: four — placeholders (from <Usd value={null}>)
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(4);
    });

    it('renders the card grid container', () => {
      render(<CostSummaryCards summary={null} />);
      expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
    });
  });

  describe('projected month calculation', () => {
    it('projects correctly on the 15th of a 30-day month (April 2026)', () => {
      // Arrange: April 2026 has 30 days; on the 15th with $150 month spend
      // projection = 150 / 15 * 30 = $300
      const summary = makeSummary(150);
      const now = new Date('2026-04-15T00:00:00Z');

      // Act
      render(<CostSummaryCards summary={summary} now={now} />);

      // Assert: $300.00 in projected card
      expect(screen.getByText('$300.00')).toBeInTheDocument();
    });

    it('projects correctly on the 1st of a 31-day month (March 2026)', () => {
      // March 2026 has 31 days; on the 1st with $10 month spend
      // projection = 10 / 1 * 31 = $310
      const summary = makeSummary(10);
      const now = new Date('2026-03-01T00:00:00Z');

      render(<CostSummaryCards summary={summary} now={now} />);

      expect(screen.getByText('$310.00')).toBeInTheDocument();
    });
  });

  describe('populated summary', () => {
    it('renders today, week, and month values formatted as USD', () => {
      // Arrange
      const summary = makeSummary(20);
      const now = new Date('2026-04-20T00:00:00Z');

      // Act
      render(<CostSummaryCards summary={summary} now={now} />);

      // Assert: today=$1.50, week=$7.25, month=$20.00
      expect(screen.getByText('$1.50')).toBeInTheDocument();
      expect(screen.getByText('$7.25')).toBeInTheDocument();
      expect(screen.getByText('$20.00')).toBeInTheDocument();
    });

    it('renders card titles for all four cards', () => {
      render(<CostSummaryCards summary={null} />);

      expect(screen.getByText('Today')).toBeInTheDocument();
      expect(screen.getByText('This week')).toBeInTheDocument();
      expect(screen.getByText('This month')).toBeInTheDocument();
      expect(screen.getByText('Projected month')).toBeInTheDocument();
    });
  });
});
