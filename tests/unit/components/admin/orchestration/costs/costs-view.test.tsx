// @vitest-environment happy-dom

/**
 * Unit Tests: CostsView
 *
 * Test Coverage:
 * - Renders all sub-sections without crashing when all props are null
 *   (except the alerts: null there means they failed to load)
 * - A failed alerts load (null) shows a notice in the alerts panel's place
 * - Renders all sub-sections without crashing with populated props
 * - Passes summary to CostSummaryCards and BudgetAlertsList
 * - Passes trend and perModel to CostTrendChart
 * - Passes byAgent rows to PerAgentCostTable and byModel to PerModelBreakdownTable
 * - Passes summary and models to LocalVsCloudPanel
 * - Renders an "Open Settings" link card pointing at /admin/orchestration/settings
 * - Shows the per-org table only with more than one org (§110 t-790)
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

vi.mock('@/components/admin/orchestration/costs/pricing-reference', () => ({
  PricingReference: ({ models, fetchedAt }: { models: unknown; fetchedAt: unknown }) => (
    <div
      data-testid="pricing-reference"
      data-has-models={models !== null ? 'true' : 'false'}
      data-has-fetched-at={fetchedAt !== null ? 'true' : 'false'}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/per-org-usage-table', () => ({
  PerOrgUsageTable: ({ report }: { report: { orgs: unknown[] } }) => (
    <div data-testid="per-org-usage-table" data-org-count={report.orgs.length} />
  ),
}));

vi.mock('@/components/admin/orchestration/costs/cost-methodology', () => ({
  CostMethodology: () => <div data-testid="cost-methodology" />,
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { CostsView } from '@/components/admin/orchestration/costs/costs-view';
import type {
  CostSummary,
  OrgUsageReport,
  OrgUsageRow,
} from '@/lib/orchestration/llm/cost-reports';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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
  byModel: [{ model: 'claude-haiku-4-5', provider: 'anthropic', monthSpend: 8.0 }],
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

const PER_MODEL = [{ key: 'claude-haiku-4-5', totalCostUsd: 8.0 }];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CostsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('null props (empty state)', () => {
    it('renders all sub-sections without crashing when all props are null', () => {
      render(
        <CostsView summary={null} alerts={null} globalCap={null} perModel={null} models={null} />
      );

      expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
      // `alerts: null` means they failed to load: the panel is a notice.
      expect(screen.queryByTestId('budget-alerts-list')).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load budget alerts");
      expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
      expect(screen.getByTestId('per-agent-cost-table')).toBeInTheDocument();
      expect(screen.getByTestId('per-model-breakdown-table')).toBeInTheDocument();
      expect(screen.getByTestId('local-vs-cloud-panel')).toBeInTheDocument();
      // The default-models form moved to the Settings page; the Costs
      // page now points at it via a footer link instead of embedding
      // the form directly.
      expect(screen.getByRole('link', { name: /open settings/i })).toBeInTheDocument();
    });

    it('passes null summary to CostSummaryCards', () => {
      render(
        <CostsView summary={null} alerts={null} globalCap={null} perModel={null} models={null} />
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
          globalCap={null}
          perModel={PER_MODEL}
          models={MOCK_MODELS}
        />
      );
    }

    it('renders all sub-sections without crashing with populated props', () => {
      renderFull();

      expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
      expect(screen.getByTestId('budget-alerts-list')).toBeInTheDocument();
      expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
      expect(screen.getByTestId('per-agent-cost-table')).toBeInTheDocument();
      expect(screen.getByTestId('per-model-breakdown-table')).toBeInTheDocument();
      expect(screen.getByTestId('local-vs-cloud-panel')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /open settings/i })).toBeInTheDocument();
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

    it('points the Settings link card at /admin/orchestration/settings', () => {
      renderFull();
      const link = screen.getByRole('link', { name: /open settings/i });
      expect(link).toHaveAttribute('href', '/admin/orchestration/settings');
    });
  });

  describe('null summary.trend fallback', () => {
    it('passes null trend to CostTrendChart when summary is null', () => {
      render(
        <CostsView summary={null} alerts={null} globalCap={null} perModel={null} models={null} />
      );
      expect(screen.getByTestId('cost-trend-chart')).toHaveAttribute('data-has-trend', 'false');
    });

    it('passes null byAgent to PerAgentCostTable when summary is null', () => {
      render(
        <CostsView summary={null} alerts={null} globalCap={null} perModel={null} models={null} />
      );
      expect(screen.getByTestId('per-agent-cost-table')).toHaveAttribute('data-has-rows', 'false');
    });
  });

  describe('pricing reference and methodology sections', () => {
    it('renders PricingReference component', () => {
      render(
        <CostsView summary={null} alerts={null} globalCap={null} perModel={null} models={null} />
      );
      expect(screen.getByTestId('pricing-reference')).toBeInTheDocument();
    });

    it('renders CostMethodology component', () => {
      render(
        <CostsView summary={null} alerts={null} globalCap={null} perModel={null} models={null} />
      );
      expect(screen.getByTestId('cost-methodology')).toBeInTheDocument();
    });

    it('passes registryFetchedAt to PricingReference', () => {
      render(
        <CostsView
          summary={null}
          alerts={null}
          globalCap={null}
          perModel={null}
          models={MOCK_MODELS}
          registryFetchedAt={1713139200000}
        />
      );
      const el = screen.getByTestId('pricing-reference');
      expect(el).toHaveAttribute('data-has-fetched-at', 'true');
      expect(el).toHaveAttribute('data-has-models', 'true');
    });
  });

  describe('budget alerts that failed to load (#518)', () => {
    it('shows a notice in the alerts panel’s place and still renders the other panels', () => {
      render(
        <CostsView
          summary={MOCK_SUMMARY}
          alerts={null}
          globalCap={null}
          perModel={PER_MODEL}
          models={MOCK_MODELS}
        />
      );

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load budget alerts");
      expect(screen.queryByTestId('budget-alerts-list')).not.toBeInTheDocument();
      expect(screen.getByTestId('cost-summary-cards')).toHaveAttribute('data-has-summary', 'true');
      expect(screen.getByTestId('cost-trend-chart')).toHaveAttribute('data-has-trend', 'true');
      expect(screen.getByTestId('per-agent-cost-table')).toHaveAttribute('data-has-rows', 'true');
      expect(screen.getByTestId('local-vs-cloud-panel')).toBeInTheDocument();
    });

    it('renders a real empty alert list through BudgetAlertsList, with no notice', () => {
      render(
        <CostsView
          summary={MOCK_SUMMARY}
          alerts={[]}
          globalCap={null}
          perModel={PER_MODEL}
          models={MOCK_MODELS}
        />
      );

      expect(screen.getByTestId('budget-alerts-list')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('per-org usage (§110 t-790)', () => {
    const orgRow = (orgId: string): OrgUsageRow => ({
      orgId,
      name: orgId,
      slug: orgId,
      status: 'ACTIVE',
      totalCostUsd: 1,
      inputTokens: 10,
      outputTokens: 1,
      count: 1,
      monthlyBudgetUsd: null,
      utilisation: null,
    });
    const report = (orgIds: string[]): OrgUsageReport => ({
      period: '2026-10',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      orgs: orgIds.map(orgRow),
      detached: null,
      totals: { totalCostUsd: orgIds.length, inputTokens: 0, outputTokens: 0, count: 0 },
    });
    const renderWith = (orgUsage: OrgUsageReport | null) =>
      render(
        <CostsView
          summary={null}
          alerts={null}
          globalCap={null}
          perModel={null}
          models={null}
          orgUsage={orgUsage}
        />
      );

    it('shows the per-org table when there is more than one org', () => {
      renderWith(report(['install', 'acme']));
      expect(screen.getByTestId('per-org-usage-table')).toHaveAttribute('data-org-count', '2');
    });

    it('hides it with one org, as at single', () => {
      renderWith(report(['install']));
      expect(screen.queryByTestId('per-org-usage-table')).not.toBeInTheDocument();
    });

    it("shows it with one org when an erased org's spend is detached", () => {
      renderWith({
        ...report(['install']),
        detached: { totalCostUsd: 2, inputTokens: 20, outputTokens: 2, count: 1 },
      });
      expect(screen.getByTestId('per-org-usage-table')).toHaveAttribute('data-org-count', '1');
    });

    it('hides it when the usage could not be loaded or was refused', () => {
      renderWith(null);
      expect(screen.queryByTestId('per-org-usage-table')).not.toBeInTheDocument();
    });
  });

  describe('an org viewer (§111 t-812)', () => {
    it('shows no per-org table and no link to the budget settings, given both', () => {
      render(
        <CostsView
          summary={MOCK_SUMMARY}
          alerts={[]}
          globalCap={null}
          perModel={PER_MODEL}
          models={MOCK_MODELS}
          orgUsage={{
            period: '2026-10',
            periodStart: '2026-10-01T00:00:00.000Z',
            periodEnd: '2026-11-01T00:00:00.000Z',
            orgs: ['install', 'acme'].map((orgId) => ({
              orgId,
              name: orgId,
              slug: orgId,
              status: 'ACTIVE',
              totalCostUsd: 1,
              inputTokens: 10,
              outputTokens: 1,
              count: 1,
              monthlyBudgetUsd: null,
              utilisation: null,
            })),
            detached: null,
            totals: { totalCostUsd: 2, inputTokens: 0, outputTokens: 0, count: 0 },
          }}
          viewerTier="org"
        />
      );

      expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
      expect(screen.queryByTestId('per-org-usage-table')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /open settings/i })).not.toBeInTheDocument();
    });
  });
});
