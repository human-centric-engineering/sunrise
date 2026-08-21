// @vitest-environment happy-dom

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
        { model: 'local:generic', provider: 'local', monthSpend: 5.5 }, // displaySpend overridden to 0
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
      const rows: CostSummaryModelRow[] = [
        { model: 'local:generic', provider: 'local', monthSpend: 0 },
      ];
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
        { model: 'unknown-provider/custom-model', provider: 'mystery', monthSpend: 3.5 },
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
      const rows: CostSummaryModelRow[] = [
        { model: 'claude-sonnet-4-6', provider: 'anthropic', monthSpend: 12.5 },
      ];
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

  describe('shared model ids across providers (#436)', () => {
    it('labels spend with the provider that served it, not a colliding catalogue row', () => {
      // Arrange — the reported failure: the default matrix seeds `gpt-4o` under
      // both `openai` and `microsoft`, and the merge appends DB-only rows last,
      // so a bare-id lookup resolved genuine OpenAI spend to the Azure entry.
      const rows: CostSummaryModelRow[] = [
        { model: 'gpt-4o', provider: 'openai', monthSpend: 1.9 },
      ];
      const models: ModelInfo[] = [
        makeModel({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', tier: 'mid' }),
        makeModel({
          id: 'gpt-4o',
          name: 'GPT-4o (Azure)',
          provider: 'microsoft',
          tier: 'frontier',
        }),
      ];

      // Act
      render(<PerModelBreakdownTable rows={rows} models={models} />);

      // Assert — OpenAI's name and provider, not Microsoft's
      expect(screen.getByText('GPT-4o')).toBeInTheDocument();
      expect(screen.queryByText('GPT-4o (Azure)')).not.toBeInTheDocument();
      expect(screen.getByText('openai')).toBeInTheDocument();
      expect(screen.queryByText('microsoft')).not.toBeInTheDocument();
    });

    it('renders one row per provider when both served the same model', () => {
      const rows: CostSummaryModelRow[] = [
        { model: 'gpt-4o', provider: 'openai', monthSpend: 1.9 },
        { model: 'gpt-4o', provider: 'microsoft', monthSpend: 0.4 },
      ];
      const models: ModelInfo[] = [
        makeModel({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }),
        makeModel({ id: 'gpt-4o', name: 'GPT-4o (Azure)', provider: 'microsoft' }),
      ];

      render(<PerModelBreakdownTable rows={rows} models={models} />);

      expect(screen.getByText('openai')).toBeInTheDocument();
      expect(screen.getByText('microsoft')).toBeInTheDocument();
      expect(screen.getByText('$1.90')).toBeInTheDocument();
      // `Usd` widens precision under a dollar.
      expect(screen.getByText('$0.4000')).toBeInTheDocument();
    });

    it('falls back to the bare id when the cost log provider is not in the catalogue', () => {
      // A renamed or custom provider: a plausible label beats no label.
      const rows: CostSummaryModelRow[] = [
        { model: 'gpt-4o', provider: 'my-proxy', monthSpend: 2 },
      ];
      const models: ModelInfo[] = [makeModel({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' })];

      render(<PerModelBreakdownTable rows={rows} models={models} />);

      expect(screen.getByText('GPT-4o')).toBeInTheDocument();
      // The provider column still reports the truth from the cost log.
      expect(screen.getByText('my-proxy')).toBeInTheDocument();
    });
  });

  describe('container', () => {
    it('renders the card wrapper with test id', () => {
      render(<PerModelBreakdownTable rows={[]} models={[]} />);
      expect(screen.getByTestId('per-model-breakdown-table')).toBeInTheDocument();
    });
  });
});
