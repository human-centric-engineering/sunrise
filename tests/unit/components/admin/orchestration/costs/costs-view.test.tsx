/**
 * Unit Tests: CostsView
 *
 * Test Coverage:
 * - Renders all six sub-sections without crashing when all props are null
 * - Renders all six sub-sections without crashing with populated props
 * - Passes summary to CostSummaryCards and BudgetAlertsList
 * - Passes trend and perModel to CostTrendChart
 * - Passes byAgent rows to PerAgentCostTable and byModel to PerModelBreakdownTable
 * - Passes summary and models to LocalVsCloudPanel
 * - Passes settings and models to OrchestrationSettingsForm
 *
 * @see components/admin/orchestration/costs/costs-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/components/admin/orchestration/costs/cost-summary-cards', () => ({
  CostSummaryCards: ({ summary }: { summary: unknown }) => (
    <div data-testid="cost-summary-cards" data-has-summary={summary !== null ? 'true' : 'false'} />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/budget-alerts-list', () => ({
  BudgetAlertsList: ({ alerts }: { alerts: unknown }) => (
    <div data-testid="budget-alerts-list" data-has-alerts={alerts !== null ? 'true' : 'false'} />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/cost-trend-chart', () => ({
  CostTrendChart: ({
    trend,
    perModel,
    models,
  }: {
    trend: unknown;
    perModel: unknown;
    models: unknown;
  }) => (
    <div
      data-testid="cost-trend-chart"
      data-has-trend={trend !== null ? 'true' : 'false'}
      data-has-per-model={perModel !== null ? 'true' : 'false'}
      data-has-models={models !== null ? 'true' : 'false'}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/per-agent-cost-table', () => ({
  PerAgentCostTable: ({ rows }: { rows: unknown }) => (
    <div data-testid="per-agent-cost-table" data-has-rows={rows !== null ? 'true' : 'false'} />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/per-model-breakdown-table', () => ({
  PerModelBreakdownTable: ({ rows, models }: { rows: unknown; models: unknown }) => (
    <div
      data-testid="per-model-breakdown-table"
      data-has-rows={rows !== null ? 'true' : 'false'}
      data-has-models={models !== null ? 'true' : 'false'}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/local-vs-cloud-panel', () => ({
  LocalVsCloudPanel: ({ summary, models }: { summary: unknown; models: unknown }) => (
    <div
      data-testid="local-vs-cloud-panel"
      data-has-summary={summary !== null ? 'true' : 'false'}
      data-has-models={models !== null ? 'true' : 'false'}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/orchestration-settings-form', () => ({
  OrchestrationSettingsForm: ({ settings, models }: { settings: unknown; models: unknown }) => (
    <div
      data-testid="orchestration-settings-form"
      data-has-settings={settings !== null ? 'true' : 'false'}
      data-has-models={models !== null ? 'true' : 'false'}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/pricing-reference', () => ({
  PricingReference: ({ models, fetchedAt }: { models: unknown; fetchedAt: unknown }) => (
    <div
      data-testid="pricing-reference"
      data-has-models={models !== null ? 'true' : 'false'}
      data-has-fetched-at={fetchedAt !== null ? 'true' : 'false'}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/cost-methodology', () => ({
  CostMethodology: () => <div data-testid="cost-methodology" />,
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { CostsView } from '@/components/admin/orchestration/costs/costs-view';
import type { CostSummary } from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';
import type { OrchestrationSettings } from '@/types/orchestration';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-15T00:00:00.000Z');

const MOCK_SUMMARY: CostSummary = {
  totals: { today: 1.5, week: 7.25, month: 42.0 },
  byAgent: [
    {
      agentId: 'agent-1',
      name: 'Support Bot',
      slug: 'support-bot',
      monthSpend: 12.5,
      monthlyBudgetUsd: null,
      utilisation: null,
    },
  ],
  byModel: [{ model: 'claude-haiku-4-5', monthSpend: 8.0 }],
  trend: [{ date: '2026-04-14', totalCostUsd: 1.2 }],
  localSavings: null,
};

const MOCK_MODELS: ModelInfo[] = [
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'budget',
    inputCostPerMillion: 0.25,
    outputCostPerMillion: 1.25,
    maxContext: 200000,
    supportsTools: true,
    available: true,
  },
];

const MOCK_SETTINGS: OrchestrationSettings = {
  id: 'settings-1',
  slug: 'global',
  defaultModels: {
    routing: 'claude-haiku-4-5',
    chat: 'claude-haiku-4-5',
    reasoning: 'claude-opus-4-6',
    embeddings: 'claude-haiku-4-5',
  },
  globalMonthlyBudgetUsd: 500,
  searchConfig: null,
  lastSeededAt: null,
  defaultApprovalTimeoutMs: null,
  approvalDefaultAction: 'deny',
  inputGuardMode: 'log_only',
  outputGuardMode: 'log_only',
  webhookRetentionDays: null,
  costLogRetentionDays: null,
  maxConversationsPerUser: null,
  maxMessagesPerConversation: null,
  escalationConfig: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const PER_MODEL = [{ key: 'claude-haiku-4-5', totalCostUsd: 8.0 }];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CostsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('null props (empty state)', () => {
    it('renders all six sub-sections without crashing when all props are null', () => {
      render(
        <CostsView summary={null} alerts={null} perModel={null} models={null} settings={null} />
      );

      expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
      expect(screen.getByTestId('budget-alerts-list')).toBeInTheDocument();
      expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
      expect(screen.getByTestId('per-agent-cost-table')).toBeInTheDocument();
      expect(screen.getByTestId('per-model-breakdown-table')).toBeInTheDocument();
      expect(screen.getByTestId('local-vs-cloud-panel')).toBeInTheDocument();
      expect(screen.getByTestId('orchestration-settings-form')).toBeInTheDocument();
    });

    it('passes null summary to CostSummaryCards', () => {
      render(
        <CostsView summary={null} alerts={null} perModel={null} models={null} settings={null} />
      );
      expect(screen.getByTestId('cost-summary-cards')).toHaveAttribute('data-has-summary', 'false');
    });
  });

  describe('populated props', () => {
    function renderFull() {
      return render(
        <CostsView
          summary={MOCK_SUMMARY}
          alerts={[]}
          perModel={PER_MODEL}
          models={MOCK_MODELS}
          settings={MOCK_SETTINGS}
        />
      );
    }

    it('renders all six sub-sections without crashing with populated props', () => {
      renderFull();

      expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
      expect(screen.getByTestId('budget-alerts-list')).toBeInTheDocument();
      expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
      expect(screen.getByTestId('per-agent-cost-table')).toBeInTheDocument();
      expect(screen.getByTestId('per-model-breakdown-table')).toBeInTheDocument();
      expect(screen.getByTestId('local-vs-cloud-panel')).toBeInTheDocument();
      expect(screen.getByTestId('orchestration-settings-form')).toBeInTheDocument();
    });

    it('passes populated summary to CostSummaryCards', () => {
      renderFull();
      expect(screen.getByTestId('cost-summary-cards')).toHaveAttribute('data-has-summary', 'true');
    });

    it('passes populated alerts to BudgetAlertsList', () => {
      renderFull();
      expect(screen.getByTestId('budget-alerts-list')).toHaveAttribute('data-has-alerts', 'true');
    });

    it('passes trend data to CostTrendChart', () => {
      renderFull();
      // summary.trend is non-null in MOCK_SUMMARY
      expect(screen.getByTestId('cost-trend-chart')).toHaveAttribute('data-has-trend', 'true');
    });

    it('passes perModel data to CostTrendChart', () => {
      renderFull();
      expect(screen.getByTestId('cost-trend-chart')).toHaveAttribute('data-has-per-model', 'true');
    });

    it('passes models to CostTrendChart', () => {
      renderFull();
      expect(screen.getByTestId('cost-trend-chart')).toHaveAttribute('data-has-models', 'true');
    });

    it('passes rows to PerAgentCostTable from summary.byAgent', () => {
      renderFull();
      expect(screen.getByTestId('per-agent-cost-table')).toHaveAttribute('data-has-rows', 'true');
    });

    it('passes rows to PerModelBreakdownTable from summary.byModel', () => {
      renderFull();
      expect(screen.getByTestId('per-model-breakdown-table')).toHaveAttribute(
        'data-has-rows',
        'true'
      );
    });

    it('passes summary and models to LocalVsCloudPanel', () => {
      renderFull();
      const panel = screen.getByTestId('local-vs-cloud-panel');
      expect(panel).toHaveAttribute('data-has-summary', 'true');
      expect(panel).toHaveAttribute('data-has-models', 'true');
    });

    it('passes settings and models to OrchestrationSettingsForm', () => {
      renderFull();
      const form = screen.getByTestId('orchestration-settings-form');
      expect(form).toHaveAttribute('data-has-settings', 'true');
      expect(form).toHaveAttribute('data-has-models', 'true');
    });
  });

  describe('null summary.trend fallback', () => {
    it('passes null trend to CostTrendChart when summary is null', () => {
      render(
        <CostsView summary={null} alerts={null} perModel={null} models={null} settings={null} />
      );
      expect(screen.getByTestId('cost-trend-chart')).toHaveAttribute('data-has-trend', 'false');
    });

    it('passes null byAgent to PerAgentCostTable when summary is null', () => {
      render(
        <CostsView summary={null} alerts={null} perModel={null} models={null} settings={null} />
      );
      expect(screen.getByTestId('per-agent-cost-table')).toHaveAttribute('data-has-rows', 'false');
    });
  });

  describe('pricing reference and methodology sections', () => {
    it('renders PricingReference component', () => {
      render(
        <CostsView summary={null} alerts={null} perModel={null} models={null} settings={null} />
      );
      expect(screen.getByTestId('pricing-reference')).toBeInTheDocument();
    });

    it('renders CostMethodology component', () => {
      render(
        <CostsView summary={null} alerts={null} perModel={null} models={null} settings={null} />
      );
      expect(screen.getByTestId('cost-methodology')).toBeInTheDocument();
    });

    it('passes registryFetchedAt to PricingReference', () => {
      render(
        <CostsView
          summary={null}
          alerts={null}
          perModel={null}
          models={MOCK_MODELS}
          settings={null}
          registryFetchedAt={1713139200000}
        />
      );
      const el = screen.getByTestId('pricing-reference');
      expect(el).toHaveAttribute('data-has-fetched-at', 'true');
      expect(el).toHaveAttribute('data-has-models', 'true');
    });
  });
});
