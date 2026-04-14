/**
 * Unit Test: ObservabilityStatsCards
 *
 * @see components/admin/orchestration/observability-stats-cards.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ObservabilityStatsCards } from '@/components/admin/orchestration/observability-stats-cards';

describe('ObservabilityStatsCards', () => {
  describe('Card titles', () => {
    it('renders all three card titles', () => {
      render(<ObservabilityStatsCards activeConversations={0} todayRequests={0} errorRate={0} />);

      expect(screen.getByText('Active Conversations')).toBeInTheDocument();
      expect(screen.getByText("Today's Requests")).toBeInTheDocument();
      expect(screen.getByText('Error Rate (24h)')).toBeInTheDocument();
    });
  });

  describe('Numeric values', () => {
    it('displays numeric counts correctly', () => {
      render(
        <ObservabilityStatsCards activeConversations={42} todayRequests={1234} errorRate={0.03} />
      );

      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.getByText('1,234')).toBeInTheDocument();
      expect(screen.getByText('3.0%')).toBeInTheDocument();
    });

    it('displays zero values without em-dash', () => {
      render(<ObservabilityStatsCards activeConversations={0} todayRequests={0} errorRate={0} />);

      // 0 should render as "0" not "—"
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('0.0%')).toBeInTheDocument();
    });
  });

  describe('Null values (em-dash fallback)', () => {
    it('displays em-dash for null activeConversations', () => {
      render(
        <ObservabilityStatsCards activeConversations={null} todayRequests={0} errorRate={0} />
      );

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('displays em-dash for null todayRequests', () => {
      render(
        <ObservabilityStatsCards activeConversations={0} todayRequests={null} errorRate={0} />
      );

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('displays em-dash for null errorRate', () => {
      render(
        <ObservabilityStatsCards activeConversations={0} todayRequests={0} errorRate={null} />
      );

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('displays em-dash for all three when all values are null', () => {
      render(
        <ObservabilityStatsCards activeConversations={null} todayRequests={null} errorRate={null} />
      );

      expect(screen.getAllByText('—')).toHaveLength(3);
    });
  });

  describe('Error rate high (> 5%) styling', () => {
    it('applies text-red-600 class to error rate value when rate > 5%', () => {
      render(
        <ObservabilityStatsCards
          activeConversations={0}
          todayRequests={0}
          errorRate={0.1} // 10% — above threshold
        />
      );

      const errorRateValue = screen.getByText('10.0%');
      expect(errorRateValue.className).toContain('text-red-600');
    });

    it('does not apply text-red-600 when error rate is at threshold (5%)', () => {
      render(
        <ObservabilityStatsCards
          activeConversations={0}
          todayRequests={0}
          errorRate={0.05} // exactly 5% — not above threshold
        />
      );

      const errorRateValue = screen.getByText('5.0%');
      expect(errorRateValue.className).not.toContain('text-red-600');
    });

    it('does not apply text-red-600 when error rate is below threshold', () => {
      render(
        <ObservabilityStatsCards
          activeConversations={0}
          todayRequests={0}
          errorRate={0.03} // 3% — below threshold
        />
      );

      const errorRateValue = screen.getByText('3.0%');
      expect(errorRateValue.className).not.toContain('text-red-600');
    });
  });
});
