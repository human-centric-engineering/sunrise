// @vitest-environment happy-dom

/**
 * LocalVsCloudPanel Component Tests
 *
 * Test Coverage:
 * - Savings callout renders formatted USD, sample size (pluralized), methodology label
 * - Empty state when pieData is empty (no local-model activity)
 * - Each methodology label variant renders correctly
 * - Local-tier rows are excluded from cloud spend (local rows always log $0)
 * - Tooltip value formatting
 *
 * Note: recharts is mocked with introspectable pass-through divs. Under
 * happy-dom the real ResponsiveContainer measures 0x0 and never renders its
 * children, so the tooltip formatter was unreachable.
 *
 * @see components/admin/orchestration/costs/local-vs-cloud-panel.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let capturedTooltipFormatter: ((v: unknown) => [string, string]) | undefined;

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  PieChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: ({ children, data }: { children: React.ReactNode; data: unknown[] }) => (
    <div data-testid="pie" data-data={JSON.stringify(data)}>
      {children}
    </div>
  ),
  Cell: ({ fill }: { fill: string }) => <div data-testid="cell" data-fill={fill} />,
  Tooltip: ({ formatter }: { formatter?: (v: unknown) => [string, string] }) => {
    capturedTooltipFormatter = formatter;
    return <div data-testid="tooltip" />;
  },
  Legend: () => <div data-testid="legend" />,
}));

import { LocalVsCloudPanel } from '@/components/admin/orchestration/costs/local-vs-cloud-panel';
import type { CostSummary } from '@/lib/orchestration/llm/cost-reports';
import type { LocalSavingsResult } from '@/types/orchestration';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

function makeSummary(localSavings: LocalSavingsResult | null, cloudSpend = 0): CostSummary {
  const byModel =
    cloudSpend > 0
      ? [{ model: 'claude-sonnet-4-6', provider: 'anthropic', monthSpend: cloudSpend }]
      : [];
  return {
    totals: { today: 0, week: 0, month: cloudSpend },
    byAgent: [],
    byModel,
    trend: [],
    localSavings,
  };
}

function makeSavings(overrides: Partial<LocalSavingsResult> = {}): LocalSavingsResult {
  return {
    usd: 42.5,
    methodology: 'tier_fallback',
    sampleSize: 5,
    dateFrom: '2026-04-01T00:00:00.000Z',
    dateTo: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}

const CLOUD_MODEL: ModelInfo = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  provider: 'anthropic',
  tier: 'mid',
  inputCostPerMillion: 3,
  outputCostPerMillion: 15,
  maxContext: 200_000,
  supportsTools: true,
};

const LOCAL_MODEL: ModelInfo = {
  id: 'llama-3.3-70b',
  name: 'Llama 3.3 70B',
  provider: 'ollama',
  tier: 'local',
  inputCostPerMillion: 0,
  outputCostPerMillion: 0,
  maxContext: 128_000,
  supportsTools: true,
};

describe('LocalVsCloudPanel', () => {
  describe('empty state', () => {
    it('shows empty state when summary is null', () => {
      render(<LocalVsCloudPanel summary={null} models={null} />);
      expect(screen.getByText('No local-model activity this month.')).toBeInTheDocument();
    });

    it('shows empty state when pieData is empty (no savings and no cloud spend)', () => {
      const summary = makeSummary(null);
      render(<LocalVsCloudPanel summary={summary} models={[]} />);
      expect(screen.getByText('No local-model activity this month.')).toBeInTheDocument();
    });
  });

  describe('savings callout', () => {
    it('renders estimated savings USD when localSavings is set', () => {
      const summary = makeSummary(makeSavings({ usd: 42.5 }), 100);
      render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);
      expect(screen.getByText('$42.50')).toBeInTheDocument();
    });

    it('renders sample size with pluralized "samples" text', () => {
      const summary = makeSummary(makeSavings({ sampleSize: 5 }), 10);
      render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);
      expect(screen.getByText('5 samples')).toBeInTheDocument();
    });

    it('renders sample size with singular "sample" text for sampleSize=1', () => {
      const summary = makeSummary(makeSavings({ sampleSize: 1 }), 10);
      render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);
      expect(screen.getByText('1 sample')).toBeInTheDocument();
    });

    it('renders methodology label: Cheapest non-local in same tier for tier_fallback', () => {
      const summary = makeSummary(makeSavings({ methodology: 'tier_fallback' }), 10);
      render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);
      expect(screen.getByText('Cheapest non-local in same tier')).toBeInTheDocument();
    });

    it('renders — for methodology when savings is null', () => {
      const summary = makeSummary(null, 10);
      render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);
      // Methodology fallback to — (may appear multiple times for USD and methodology)
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('container', () => {
    it('renders the card wrapper with test id', () => {
      render(<LocalVsCloudPanel summary={null} models={null} />);
      expect(screen.getByTestId('local-vs-cloud-panel')).toBeInTheDocument();
    });
  });
});

describe('LocalVsCloudPanel spend split', () => {
  function summaryWithRows(byModel: CostSummary['byModel']): CostSummary {
    return {
      totals: { today: 0, week: 0, month: 0 },
      byAgent: [],
      byModel,
      trend: [],
      localSavings: makeSavings(),
    };
  }

  it('excludes local-tier rows from cloud spend', () => {
    // A local row's `monthSpend` is $0 by construction, but the point of the
    // branch is that local rows are never added to the CLOUD figure — a fork
    // that starts charging for local inference must not have it silently
    // reported as cloud spend.
    const summary = summaryWithRows([
      { model: 'claude-sonnet-4-6', provider: 'anthropic', monthSpend: 30 },
      { model: 'llama-3.3-70b', provider: 'ollama', monthSpend: 99 },
    ]);

    render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL, LOCAL_MODEL]} />);

    expect(screen.getByText('Cloud spend:').parentElement).toHaveTextContent('$30.00');
    expect(screen.getByText('Local spend:').parentElement).toHaveTextContent('$0.00');
  });

  it('counts a row whose model is absent from the catalogue as cloud', () => {
    // Unknown tier is treated as cloud: under-reporting real spend would be the
    // worse error, and a deleted registry entry must not make spend vanish.
    const summary = summaryWithRows([{ model: 'ghost', provider: 'nowhere', monthSpend: 12 }]);

    render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);

    expect(screen.getByText('Cloud spend:').parentElement).toHaveTextContent('$12.00');
  });

  it('resolves tier by provider, not by bare model id', () => {
    // The same id can exist under two providers with different tiers (#436).
    // Keyed on the id alone, this row would resolve to whichever entry merged
    // last and the spend could land on the wrong side of the split.
    const sharedLocal: ModelInfo = { ...LOCAL_MODEL, id: 'gpt-4o', provider: 'local-proxy' };
    const sharedCloud: ModelInfo = { ...CLOUD_MODEL, id: 'gpt-4o', provider: 'openai' };
    const summary = summaryWithRows([{ model: 'gpt-4o', provider: 'openai', monthSpend: 25 }]);

    render(<LocalVsCloudPanel summary={summary} models={[sharedLocal, sharedCloud]} />);

    expect(screen.getByText('Cloud spend:').parentElement).toHaveTextContent('$25.00');
  });
});

describe('LocalVsCloudPanel tooltip formatter', () => {
  function renderChart() {
    render(<LocalVsCloudPanel summary={makeSummary(makeSavings(), 100)} models={[CLOUD_MODEL]} />);
  }

  it('formats a numeric value to two decimal places', () => {
    renderChart();
    expect(capturedTooltipFormatter?.(12.345)).toEqual(['$12.35', '']);
  });

  it('coerces a numeric string rather than rendering NaN', () => {
    renderChart();
    expect(capturedTooltipFormatter?.('7.5')).toEqual(['$7.50', '']);
  });

  it('falls back to zero for a non-numeric value', () => {
    renderChart();
    expect(capturedTooltipFormatter?.('n/a')).toEqual(['$0.00', '']);
  });
});

describe('methodologyLabel fallback', () => {
  it('renders an unrecognised methodology as its raw slug', () => {
    // `SavingsMethodology` is a single-member union today, so this needs a cast
    // — deliberately. The field is documented as extensible without a
    // response-shape break, which means an older client WILL meet a mode it
    // does not know. It must show the raw slug, not a blank cell.
    const summary = makeSummary(
      makeSavings({ methodology: 'exact_hosted_match' as LocalSavingsResult['methodology'] }),
      10
    );

    render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);

    expect(screen.getByText('exact_hosted_match')).toBeInTheDocument();
  });
});
