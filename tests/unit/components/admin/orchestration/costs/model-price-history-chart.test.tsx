/**
 * ModelPriceHistoryChart Component Tests
 *
 * @see components/admin/orchestration/costs/model-price-history-chart.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ModelPriceHistoryChart } from '@/components/admin/orchestration/costs/model-price-history-chart';
import type { ModelPricingTimeline } from '@/lib/orchestration/llm/pricing-history';

const MOCK_TIMELINE: ModelPricingTimeline = {
  id: 'gpt-4o',
  vendor: 'openai',
  name: 'GPT-4o',
  periods: [
    {
      input: 5,
      output: 15,
      inputCached: null,
      fromDate: '2024-05-13',
      toDate: '2024-10-01',
    },
    {
      input: 2.5,
      output: 10,
      inputCached: 1.25,
      fromDate: '2024-10-01',
      toDate: null,
    },
  ],
};

const SINGLE_PERIOD_TIMELINE: ModelPricingTimeline = {
  id: 'claude-haiku-4-5',
  vendor: 'anthropic',
  name: 'Claude Haiku 4.5',
  periods: [
    {
      input: 1,
      output: 5,
      inputCached: 0.5,
      fromDate: '2025-10-01',
      toDate: null,
    },
  ],
};

const EMPTY_TIMELINE: ModelPricingTimeline = {
  id: 'empty-model',
  vendor: 'test',
  name: 'Empty Model',
  periods: [],
};

describe('ModelPriceHistoryChart', () => {
  it('renders with test id', () => {
    render(<ModelPriceHistoryChart timeline={MOCK_TIMELINE} />);
    expect(screen.getByTestId('model-price-history-chart')).toBeInTheDocument();
  });

  it('shows model name and vendor', () => {
    render(<ModelPriceHistoryChart timeline={MOCK_TIMELINE} />);
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('(openai)')).toBeInTheDocument();
  });

  it('shows price change percentage for input', () => {
    render(<ModelPriceHistoryChart timeline={MOCK_TIMELINE} />);
    // Input went from $5 to $2.5 = -50%
    expect(screen.getByText(/Input: -50%/)).toBeInTheDocument();
  });

  it('shows price change percentage for output', () => {
    render(<ModelPriceHistoryChart timeline={MOCK_TIMELINE} />);
    // Output went from $15 to $10 = -33%
    expect(screen.getByText(/Output: -33%/)).toBeInTheDocument();
  });

  it('shows "No price changes" for single-period timeline', () => {
    render(<ModelPriceHistoryChart timeline={SINGLE_PERIOD_TIMELINE} />);
    expect(screen.getByText('No price changes')).toBeInTheDocument();
  });

  it('shows empty message for timeline with no periods', () => {
    render(<ModelPriceHistoryChart timeline={EMPTY_TIMELINE} />);
    expect(screen.getByText('No pricing history available for this model.')).toBeInTheDocument();
  });

  it('shows date range in footer', () => {
    render(<ModelPriceHistoryChart timeline={MOCK_TIMELINE} />);
    expect(screen.getByText(/2024-05-13/)).toBeInTheDocument();
    expect(screen.getByText(/2 price changes/)).toBeInTheDocument();
  });

  it('shows "1 price point" for single period', () => {
    render(<ModelPriceHistoryChart timeline={SINGLE_PERIOD_TIMELINE} />);
    expect(screen.getByText(/1 price point/)).toBeInTheDocument();
  });

  it('links to llm-prices.com as data source', () => {
    render(<ModelPriceHistoryChart timeline={MOCK_TIMELINE} />);
    const link = screen.getByText('llm-prices.com');
    expect(link).toHaveAttribute('href', 'https://www.llm-prices.com');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('applies green color to negative price changes', () => {
    render(<ModelPriceHistoryChart timeline={MOCK_TIMELINE} />);
    const inputChange = screen.getByText(/Input: -50%/);
    expect(inputChange.className).toContain('text-green-600');
  });
});
