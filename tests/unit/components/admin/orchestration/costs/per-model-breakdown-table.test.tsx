/**
 * PerModelBreakdownTable Component Tests
 *
 * Test Coverage:
 * - Local-tier model renders $0.00 and a "Local" badge
 * - Model missing from registry still renders (fallback display)
 * - Empty state when byModel is empty
 *
 * @see components/admin/orchestration/costs/per-model-breakdown-table.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PerModelBreakdownTable } from '@/components/admin/orchestration/costs/per-model-breakdown-table';
import type { CostSummaryModelRow } from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'mid',
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    maxContext: 200_000,
    supportsTools: true,
    ...overrides,
  };
}

describe('PerModelBreakdownTable', () => {
  describe('empty state', () => {
    it('shows empty state message when rows is null', () => {
      render(<PerModelBreakdownTable rows={null} models={null} />);
      expect(screen.getByText('No model spend recorded this month.')).toBeInTheDocument();
    });

    it('shows empty state message when rows is empty array', () => {
      render(<PerModelBreakdownTable rows={[]} models={[]} />);
      expect(screen.getByText('No model spend recorded this month.')).toBeInTheDocument();
    });
  });

  describe('local tier model', () => {
    it('renders $0.00 for a local-tier model', () => {
      // Arrange: a local model in the registry with some spend (cost-tracker logs $0 anyway)
      const rows: CostSummaryModelRow[] = [
        { model: 'local:generic', monthSpend: 5.5 }, // displaySpend overridden to 0
      ];
      const models: ModelInfo[] = [
        makeModel({
          id: 'local:generic',
          name: 'Local Model (generic)',
          provider: 'local',
          tier: 'local',
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
        }),
      ];

      // Act
      render(<PerModelBreakdownTable rows={rows} models={models} />);

      // Assert: spend shows $0.00, and Local badge is present
      expect(screen.getByText('$0.00')).toBeInTheDocument();
      expect(screen.getByText('Local')).toBeInTheDocument();
    });

    it('renders the Local badge text for local-tier models', () => {
      const rows: CostSummaryModelRow[] = [{ model: 'local:generic', monthSpend: 0 }];
      const models: ModelInfo[] = [
        makeModel({
          id: 'local:generic',
          tier: 'local',
        }),
      ];

      render(<PerModelBreakdownTable rows={rows} models={models} />);

      // Assert the "Local" text is present (from the Badge component)
      expect(screen.getByText('Local')).toBeInTheDocument();
    });
  });

  describe('model not in registry', () => {
    it('renders the row with fallback — display for provider and tier when model is unknown', () => {
      // Arrange: row exists but model not in registry
      const rows: CostSummaryModelRow[] = [
        { model: 'unknown-provider/custom-model', monthSpend: 3.5 },
      ];

      // Act: pass empty models array so nothing is in the registry
      render(<PerModelBreakdownTable rows={rows} models={[]} />);

      // Assert: model id rendered as name fallback, — for provider and tier
      expect(screen.getByText('unknown-provider/custom-model')).toBeInTheDocument();
      // Provider and tier fall back to — when info is undefined
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('non-local model with spend', () => {
    it('renders the model name, provider, and tier for a normal model', () => {
      const rows: CostSummaryModelRow[] = [{ model: 'claude-sonnet-4-6', monthSpend: 12.5 }];
      const models: ModelInfo[] = [
        makeModel({ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' }),
      ];

      render(<PerModelBreakdownTable rows={rows} models={models} />);

      expect(screen.getByText('Claude Sonnet 4.6')).toBeInTheDocument();
      expect(screen.getByText('anthropic')).toBeInTheDocument();
      // Tier badge
      expect(screen.getByText('mid')).toBeInTheDocument();
      // Cost displayed
      expect(screen.getByText('$12.50')).toBeInTheDocument();
    });
  });

  describe('container', () => {
    it('renders the card wrapper with test id', () => {
      render(<PerModelBreakdownTable rows={[]} models={[]} />);
      expect(screen.getByTestId('per-model-breakdown-table')).toBeInTheDocument();
    });
  });
});
