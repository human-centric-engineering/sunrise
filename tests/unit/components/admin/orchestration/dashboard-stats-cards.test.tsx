/**
 * Unit Test: DashboardStatsCards
 *
 * Covers the consolidated 4-card operational stats row:
 * - Null values render em-dashes
 * - Number/currency/percent formatting
 * - Each card links to its detail page
 * - High error rate applies red styling
 *
 * @see components/admin/orchestration/dashboard-stats-cards.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DashboardStatsCards } from '@/components/admin/orchestration/dashboard-stats-cards';

describe('DashboardStatsCards', () => {
  // ── Null fallback ───────────────────────────────────────────────────────

  describe('null values', () => {
    it('renders em-dashes when all values are null', () => {
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
  });

  // ── Formatting ──────────────────────────────────────────────────────────

  describe('formatting', () => {
    it('formats agent count with locale separators', () => {
      render(
        <DashboardStatsCards
          agentsCount={1234}
          todayCostUsd={null}
          todayRequests={null}
          errorRate={null}
        />
      );

      expect(screen.getByText('1,234')).toBeInTheDocument();
    });

    it('formats cost as USD with two decimals', () => {
      render(
        <DashboardStatsCards
          agentsCount={null}
          todayCostUsd={4.2}
          todayRequests={null}
          errorRate={null}
        />
      );

      expect(screen.getByText('$4.20')).toBeInTheDocument();
    });

    it('formats request count with locale separators', () => {
      render(
        <DashboardStatsCards
          agentsCount={null}
          todayCostUsd={null}
          todayRequests={847}
          errorRate={null}
        />
      );

      expect(screen.getByText('847')).toBeInTheDocument();
    });

    it('formats error rate as percentage', () => {
      render(
        <DashboardStatsCards
          agentsCount={null}
          todayCostUsd={null}
          todayRequests={null}
          errorRate={0.032}
        />
      );

      expect(screen.getByText('3.2%')).toBeInTheDocument();
    });

    it('displays zero values correctly (not em-dash)', () => {
      render(
        <DashboardStatsCards agentsCount={0} todayCostUsd={0} todayRequests={0} errorRate={0} />
      );

      expect(screen.getByText('$0.00')).toBeInTheDocument();
      expect(screen.getByText('0.0%')).toBeInTheDocument();
      // Two "0" values for agents and requests
      expect(screen.getAllByText('0')).toHaveLength(2);
    });
  });

  // ── Clickable links ─────────────────────────────────────────────────────

  describe('navigation links', () => {
    it('agents card links to agents list', () => {
      render(
        <DashboardStatsCards
          agentsCount={5}
          todayCostUsd={null}
          todayRequests={null}
          errorRate={null}
        />
      );

      const links = screen.getAllByRole('link');
      const agentsLink = links.find(
        (el) => el.getAttribute('href') === '/admin/orchestration/agents'
      );
      expect(agentsLink).toBeDefined();
    });

    it('spend card links to costs page', () => {
      render(
        <DashboardStatsCards
          agentsCount={null}
          todayCostUsd={10}
          todayRequests={null}
          errorRate={null}
        />
      );

      const links = screen.getAllByRole('link');
      const costsLink = links.find(
        (el) => el.getAttribute('href') === '/admin/orchestration/costs'
      );
      expect(costsLink).toBeDefined();
    });

    it('requests card links to conversations page', () => {
      render(
        <DashboardStatsCards
          agentsCount={null}
          todayCostUsd={null}
          todayRequests={100}
          errorRate={null}
        />
      );

      const links = screen.getAllByRole('link');
      const link = links.find(
        (el) => el.getAttribute('href') === '/admin/orchestration/conversations'
      );
      expect(link).toBeDefined();
    });

    it('error rate card links to analytics page', () => {
      render(
        <DashboardStatsCards
          agentsCount={null}
          todayCostUsd={null}
          todayRequests={null}
          errorRate={0.01}
        />
      );

      const links = screen.getAllByRole('link');
      const link = links.find((el) => el.getAttribute('href') === '/admin/orchestration/analytics');
      expect(link).toBeDefined();
    });

    it('renders exactly 4 clickable links', () => {
      render(
        <DashboardStatsCards agentsCount={1} todayCostUsd={1} todayRequests={1} errorRate={0.01} />
      );

      expect(screen.getAllByRole('link')).toHaveLength(4);
    });
  });

  // ── Error rate styling ──────────────────────────────────────────────────

  describe('error rate high styling', () => {
    it('applies red text when error rate exceeds 5%', () => {
      render(
        <DashboardStatsCards
          agentsCount={null}
          todayCostUsd={null}
          todayRequests={null}
          errorRate={0.1}
        />
      );

      const errorValue = screen.getByText('10.0%');
      expect(errorValue.className).toContain('text-red-600');
    });

    it('does not apply red text when error rate is at 5% threshold', () => {
      render(
        <DashboardStatsCards
          agentsCount={null}
          todayCostUsd={null}
          todayRequests={null}
          errorRate={0.05}
        />
      );

      const errorValue = screen.getByText('5.0%');
      expect(errorValue.className).not.toContain('text-red-600');
    });

    it('does not apply red text when error rate is below 5%', () => {
      render(
        <DashboardStatsCards
          agentsCount={null}
          todayCostUsd={null}
          todayRequests={null}
          errorRate={0.02}
        />
      );

      const errorValue = screen.getByText('2.0%');
      expect(errorValue.className).not.toContain('text-red-600');
    });
  });
});
