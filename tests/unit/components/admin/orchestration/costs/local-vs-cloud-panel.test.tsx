/**
 * LocalVsCloudPanel Component Tests
 *
 * Test Coverage:
 * - Savings callout renders formatted USD, sample size (pluralized), methodology label
 * - Empty state when pieData is empty (no local-model activity)
 * - Each methodology label variant renders correctly
 *
 * @see components/admin/orchestration/costs/local-vs-cloud-panel.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { LocalVsCloudPanel } from '@/components/admin/orchestration/costs/local-vs-cloud-panel';
import type { CostSummary } from '@/lib/orchestration/llm/cost-reports';
import type { LocalSavingsResult } from '@/types/orchestration';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

function makeSummary(localSavings: LocalSavingsResult | null, cloudSpend = 0): CostSummary {
  const byModel = cloudSpend > 0 ? [{ model: 'claude-sonnet-4-6', monthSpend: cloudSpend }] : [];
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
    methodology: 'equivalent_hosted',
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

    it('renders methodology label: Exact hosted-model match for equivalent_hosted', () => {
      const summary = makeSummary(makeSavings({ methodology: 'equivalent_hosted' }), 10);
      render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);
      expect(screen.getByText('Exact hosted-model match')).toBeInTheDocument();
    });

    it('renders methodology label: Cheapest non-local in same tier for tier_fallback', () => {
      const summary = makeSummary(makeSavings({ methodology: 'tier_fallback' }), 10);
      render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);
      expect(screen.getByText('Cheapest non-local in same tier')).toBeInTheDocument();
    });

    it('renders methodology label: Mixed (both methods) for mixed', () => {
      const summary = makeSummary(makeSavings({ methodology: 'mixed' }), 10);
      render(<LocalVsCloudPanel summary={summary} models={[CLOUD_MODEL]} />);
      expect(screen.getByText('Mixed (both methods)')).toBeInTheDocument();
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
