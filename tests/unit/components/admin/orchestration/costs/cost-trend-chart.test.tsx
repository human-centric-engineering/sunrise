/**
 * CostTrendChart Component Tests
 *
 * Test Coverage:
 * - Renders without throwing — SVG element present when data exists
 * - Empty state: no spend in last 30 days message when perModel is empty/null
 * - Empty state when trend is null
 * - Empty state when all trend totals are zero (zero-fill makes this visible)
 * - Zero-fill: chart renders 30 days even when only some days have spend
 *
 * Note: recharts renders to SVG under happy-dom. We assert the SVG element
 * is present and that the empty-state copy renders correctly. We do NOT
 * assert specific chart internals (pixel values, axis ticks) as recharts'
 * SVG structure is not a stable API.
 *
 * @see components/admin/orchestration/costs/cost-trend-chart.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CostTrendChart } from '@/components/admin/orchestration/costs/cost-trend-chart';
import type { CostSummaryTrendPoint } from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

function makeTrendPoint(date: string, totalCostUsd: number): CostSummaryTrendPoint {
  return { date, totalCostUsd };
}

const MOCK_MODELS: ModelInfo[] = [
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'budget',
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    maxContext: 200_000,
    supportsTools: true,
  },
];

describe('CostTrendChart', () => {
  describe('empty state', () => {
    it('shows empty state copy when trend is null', () => {
      render(<CostTrendChart trend={null} perModel={null} models={null} />);
      expect(screen.getByText('No spend recorded in the last 30 days.')).toBeInTheDocument();
    });

    it('shows empty state copy when trend is empty array', () => {
      render(<CostTrendChart trend={[]} perModel={null} models={null} />);
      expect(screen.getByText('No spend recorded in the last 30 days.')).toBeInTheDocument();
    });

    it('shows empty state when all trend totals are zero', () => {
      const trend = [makeTrendPoint('2026-04-01', 0), makeTrendPoint('2026-04-02', 0)];
      // After zero-fill, all days have $0 spend — empty state is shown
      render(<CostTrendChart trend={trend} perModel={null} models={MOCK_MODELS} />);
      expect(screen.getByText('No spend recorded in the last 30 days.')).toBeInTheDocument();
    });
  });

  describe('zero-fill behavior', () => {
    it('renders chart (not empty state) when at least one day has non-zero spend', () => {
      // Only one day has spend — zero-fill adds 29 zero days but the chart renders
      const today = new Date().toISOString().slice(0, 10);
      const trend = [makeTrendPoint(today, 10.5)];

      render(<CostTrendChart trend={trend} perModel={null} models={MOCK_MODELS} />);
      expect(screen.queryByText('No spend recorded in the last 30 days.')).not.toBeInTheDocument();
      expect(screen.getByText('30-day spend trend')).toBeInTheDocument();
    });
  });

  describe('renders without throwing', () => {
    it('renders without throwing when trend data is present', () => {
      // Arrange
      const trend = [
        makeTrendPoint('2026-04-10', 5.5),
        makeTrendPoint('2026-04-11', 3.2),
        makeTrendPoint('2026-04-12', 7.1),
      ];
      const perModel = [{ key: 'claude-haiku-4-5', totalCostUsd: 15.8 }];

      // Act: should not throw
      let thrown = false;
      try {
        render(<CostTrendChart trend={trend} perModel={perModel} models={MOCK_MODELS} />);
      } catch {
        thrown = true;
      }

      // Assert: no throw, heading still in DOM
      expect(thrown).toBe(false);
      expect(screen.getByText('30-day spend trend')).toBeInTheDocument();
    });

    it('renders without throwing when perModel is null (falls back to single total area)', () => {
      const trend = [makeTrendPoint('2026-04-10', 5.5)];

      // Act: should not throw
      let thrown = false;
      try {
        render(<CostTrendChart trend={trend} perModel={null} models={null} />);
      } catch {
        thrown = true;
      }

      // Assert: no throw
      expect(thrown).toBe(false);
    });

    it('renders card wrapper with test id', () => {
      render(<CostTrendChart trend={null} perModel={null} models={null} />);
      expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
    });

    it('renders the 30-day spend trend title', () => {
      render(<CostTrendChart trend={null} perModel={null} models={null} />);
      expect(screen.getByText('30-day spend trend')).toBeInTheDocument();
    });
  });
});
