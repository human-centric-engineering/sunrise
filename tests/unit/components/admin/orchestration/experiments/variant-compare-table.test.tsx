/**
 * Component tests: VariantCompareTable.
 *
 * Coverage:
 * - Renders the control + challenger column headers
 * - Renders one row per metric with mean + n
 * - Shows the Trophy + label when a challenger wins
 * - Shows "no clear winner" when stats don't pass
 *
 * @see components/admin/orchestration/experiments/variant-compare-table.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VariantCompareTable } from '@/components/admin/orchestration/experiments/variant-compare-table';

function variant(label: string, scoresPerMetric: Record<string, number[]>) {
  const meanByMetric: Record<string, number | null> = {};
  for (const [slug, scores] of Object.entries(scoresPerMetric)) {
    meanByMetric[slug] =
      scores.length === 0 ? null : scores.reduce((s, x) => s + x, 0) / scores.length;
  }
  return {
    variantId: label,
    label,
    rawScores: scoresPerMetric,
    meanByMetric,
    runStatus: 'completed' as const,
  };
}

describe('VariantCompareTable', () => {
  it('renders the control label + each challenger label as column headers', () => {
    render(
      <VariantCompareTable
        variants={[
          variant('My Control', { faithfulness: [0.5, 0.6, 0.5] }),
          variant('Challenger X', { faithfulness: [0.4, 0.5, 0.6] }),
        ]}
        metricSlugs={['faithfulness']}
      />
    );
    // Control label gets a " (control)" suffix in the header
    expect(screen.getByText(/My Control \(control\)/i)).toBeInTheDocument();
    expect(screen.getByText('Challenger X')).toBeInTheDocument();
  });

  it('renders mean and n for every cell', () => {
    render(
      <VariantCompareTable
        variants={[
          variant('A', { metric_x: [0.4, 0.5, 0.6] }),
          variant('B', { metric_x: [0.7, 0.8, 0.9] }),
        ]}
        metricSlugs={['metric_x']}
      />
    );
    expect(screen.getByText('0.500')).toBeInTheDocument(); // control mean
    expect(screen.getByText('0.800')).toBeInTheDocument(); // challenger mean
    expect(screen.getAllByText(/n = 3/).length).toBeGreaterThan(0);
  });

  it('shows the winner label when a challenger crosses all three thresholds', () => {
    const control = variant('Original', {
      m: Array.from({ length: 20 }, (_, i) => 0.2 + 0.01 * i),
    });
    const winner = variant('Improved', {
      m: Array.from({ length: 20 }, (_, i) => 0.7 + 0.01 * i),
    });
    render(<VariantCompareTable variants={[control, winner]} metricSlugs={['m']} />);
    // "Improved" appears in the column header AND in the winner column
    // (it crowned itself winner) — assert both appearances are present.
    expect(screen.getAllByText('Improved').length).toBeGreaterThanOrEqual(2);
  });

  it('shows "no clear winner" when stats do not pass', () => {
    const a = variant('A', {
      m: [0.5, 0.5, 0.5, 0.51, 0.49, 0.5, 0.49, 0.51],
    });
    const b = variant('B', {
      m: [0.51, 0.5, 0.49, 0.5, 0.5, 0.51, 0.5, 0.51],
    });
    render(<VariantCompareTable variants={[a, b]} metricSlugs={['m']} />);
    expect(screen.getByText(/no clear winner/i)).toBeInTheDocument();
  });

  it('shows "n < 2" badge for variants with insufficient samples', () => {
    const a = variant('Control', { m: [0.5, 0.6, 0.5] });
    const b = variant('Sparse', { m: [0.7] });
    render(<VariantCompareTable variants={[a, b]} metricSlugs={['m']} />);
    expect(screen.getByText(/n < 2/i)).toBeInTheDocument();
  });

  it('renders the per-metric comparison heading + control attribution', () => {
    render(
      <VariantCompareTable
        variants={[variant('Alpha', { m: [0.5, 0.5] }), variant('Beta', { m: [0.6, 0.6] })]}
        metricSlugs={['m']}
      />
    );
    expect(screen.getByText(/Per-metric comparison/i)).toBeInTheDocument();
    expect(screen.getByText(/Alpha is the control/)).toBeInTheDocument();
  });

  it('shows a fallback when fewer than 2 variants are provided', () => {
    render(<VariantCompareTable variants={[variant('Solo', { m: [0.5] })]} metricSlugs={['m']} />);
    expect(screen.getByText(/At least 2 variants are required/i)).toBeInTheDocument();
  });
});
