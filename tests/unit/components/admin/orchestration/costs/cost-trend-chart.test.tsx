// @vitest-environment happy-dom

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
 * - Tier split: proportional attribution, unknown-model rows, first-write-wins
 *   on a duplicated model id, and the single-bucket fallback
 * - Axis / tooltip formatters
 *
 * Note: recharts is mocked with introspectable pass-through divs (the same
 * pattern as evaluation-trend-chart.test.tsx). Under happy-dom the real
 * ResponsiveContainer measures 0x0 and never renders its children, so the
 * computed plot rows and the axis/tooltip formatters were unreachable — the
 * component's actual arithmetic could not be asserted at all. The mock captures
 * the `data` prop and the two formatter callbacks instead.
 *
 * @see components/admin/orchestration/costs/cost-trend-chart.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ---------------------------------------------------------------------------
// recharts mock — introspectable pass-through divs
// ---------------------------------------------------------------------------

let capturedTickFormatter: ((v: number) => string) | undefined;
let capturedTooltipFormatter: ((value: unknown, name: unknown) => [string, string]) | undefined;

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  ComposedChart: ({
    children,
    data,
  }: {
    children: React.ReactNode;
    data: Record<string, unknown>[];
  }) => (
    <div data-testid="composed-chart" data-data={JSON.stringify(data)}>
      {children}
    </div>
  ),
  Area: ({ dataKey }: { dataKey: string }) => <div data-testid="area" data-area-key={dataKey} />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: ({ tickFormatter }: { tickFormatter?: (v: number) => string }) => {
    capturedTickFormatter = tickFormatter;
    return <div data-testid="y-axis" />;
  },
  Tooltip: ({ formatter }: { formatter?: (value: unknown, name: unknown) => [string, string] }) => {
    capturedTooltipFormatter = formatter;
    return <div data-testid="tooltip" />;
  },
  Legend: () => <div data-testid="legend" />,
}));

import { CostTrendChart } from '@/components/admin/orchestration/costs/cost-trend-chart';
import type { CostSummaryTrendPoint } from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';
import { formatUsd } from '@/lib/utils/format-currency';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PlotRow {
  date: string;
  budget: number;
  mid: number;
  frontier: number;
  local: number;
  total: number;
}

/** The rows the component actually handed to recharts. */
function plotRows(): PlotRow[] {
  const raw = screen.getByTestId('composed-chart').getAttribute('data-data');
  return JSON.parse(raw ?? '[]') as PlotRow[];
}

function model(id: string, tier: ModelInfo['tier'], provider = 'anthropic'): ModelInfo {
  return {
    id,
    name: id,
    provider,
    tier,
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    maxContext: 200_000,
    supportsTools: true,
  };
}

describe('CostTrendChart tier split', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('splits a day total by the 30-day tier distribution', () => {
    // 3:1 budget:frontier over the window, so a $100 day splits $75/$25.
    render(
      <CostTrendChart
        trend={[makeTrendPoint(today, 100)]}
        perModel={[
          { key: 'cheap', totalCostUsd: 30 },
          { key: 'pricey', totalCostUsd: 10 },
        ]}
        models={[model('cheap', 'budget'), model('pricey', 'frontier')]}
      />
    );

    const day = plotRows().find((r) => r.date === today)!;
    expect(day.budget).toBeCloseTo(75, 6);
    expect(day.frontier).toBeCloseTo(25, 6);
    expect(day.mid).toBe(0);
    expect(day.local).toBe(0);
    // The split is an attribution of the real total, never a restatement of it.
    expect(day.budget + day.mid + day.frontier + day.local).toBeCloseTo(day.total, 6);
  });

  it('ignores a perModel row whose model is not in the catalogue', () => {
    // A model deleted from the registry still has cost rows. Counting it into a
    // tier would be a guess; it is skipped, so the remaining split is unchanged.
    render(
      <CostTrendChart
        trend={[makeTrendPoint(today, 50)]}
        perModel={[
          { key: 'cheap', totalCostUsd: 40 },
          { key: 'ghost-model', totalCostUsd: 999 },
        ]}
        models={[model('cheap', 'budget')]}
      />
    );

    const day = plotRows().find((r) => r.date === today)!;
    expect(day.budget).toBeCloseTo(50, 6);
    expect(day.frontier).toBe(0);
  });

  it('keeps the first catalogue entry when a model id appears twice', () => {
    // First-write-wins (#436). The static registry is merged ahead of DB-only
    // rows, so a seeded example under a second provider must not displace the
    // real entry and drag that spend into the wrong tier.
    render(
      <CostTrendChart
        trend={[makeTrendPoint(today, 80)]}
        perModel={[{ key: 'gpt-4o', totalCostUsd: 20 }]}
        models={[model('gpt-4o', 'mid', 'openai'), model('gpt-4o', 'frontier', 'microsoft')]}
      />
    );

    const day = plotRows().find((r) => r.date === today)!;
    expect(day.mid).toBeCloseTo(80, 6);
    expect(day.frontier).toBe(0);
  });

  it('attributes everything to a single bucket when no tier data is available', () => {
    // No models, so tierSum is 0 — the chart must still show the real total
    // rather than a flat zero line that reads as "no spend".
    render(<CostTrendChart trend={[makeTrendPoint(today, 42)]} perModel={[]} models={[]} />);

    const day = plotRows().find((r) => r.date === today)!;
    expect(day.total).toBeCloseTo(42, 6);
    expect(day.mid).toBeCloseTo(42, 6);
    expect(day.budget).toBe(0);
  });

  it('zero-fills a day with no spend even when tier data exists', () => {
    render(
      <CostTrendChart
        trend={[makeTrendPoint(today, 10)]}
        perModel={[{ key: 'cheap', totalCostUsd: 5 }]}
        models={[model('cheap', 'budget')]}
      />
    );

    const rows = plotRows();
    expect(rows).toHaveLength(30);
    const blank = rows.find((r) => r.date !== today)!;
    expect(blank).toMatchObject({ budget: 0, mid: 0, frontier: 0, local: 0, total: 0 });
  });
});

describe('CostTrendChart formatters', () => {
  const today = new Date().toISOString().slice(0, 10);

  function renderChart() {
    render(
      <CostTrendChart
        trend={[makeTrendPoint(today, 1234.5)]}
        perModel={[{ key: 'cheap', totalCostUsd: 5 }]}
        models={[model('cheap', 'budget')]}
      />
    );
  }

  it('formats Y-axis ticks compactly', () => {
    renderChart();
    // Compact form keeps a 30-day axis legible; the full value belongs in the
    // tooltip, not on every gridline.
    expect(capturedTickFormatter?.(1234.5)).toBe(formatUsd(1234.5, { compact: true }));
  });

  it('formats tooltip values at full precision with the series name', () => {
    renderChart();
    expect(capturedTooltipFormatter?.(12.3456, 'budget')).toEqual([formatUsd(12.3456), 'budget']);
  });

  it('coerces a non-numeric tooltip value rather than rendering NaN', () => {
    renderChart();
    expect(capturedTooltipFormatter?.('7.5', 'mid')).toEqual([formatUsd(7.5), 'mid']);
    expect(capturedTooltipFormatter?.('not-a-number', 'mid')).toEqual([formatUsd(0), 'mid']);
  });

  it('renders an empty series name rather than "null"', () => {
    renderChart();
    expect(capturedTooltipFormatter?.(1, null)).toEqual([formatUsd(1), '']);
  });
});
