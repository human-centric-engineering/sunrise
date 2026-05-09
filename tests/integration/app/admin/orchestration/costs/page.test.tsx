/**
 * Integration Test: Admin Orchestration — Costs & Budget Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/costs/page.tsx`.
 *
 * Test Coverage:
 * - Happy path: all 5 parallel fetches succeed, page sections render
 * - Every fetch rejects: page renders stable empty-state layout, does not throw
 * - Partial failure: some fetches fail, rest still render
 *
 * @see app/admin/orchestration/costs/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

// CostsPage's server component awaits refreshFromOpenRouter() before
// rendering. Without this mock every test fires a real 10-second HTTP
// request to openrouter.ai — flake risk and CI dependency on a third
// party. The route under test exercises cost summary fetching, not
// the model registry refresh, so a no-op resolution is the right stub.
vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  refreshFromOpenRouter: vi.fn(() => Promise.resolve()),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_SUMMARY = {
  totals: { today: 1.5, week: 7.25, month: 22.0 },
  byAgent: [
    {
      agentId: 'agent-1',
      name: 'Alpha Bot',
      slug: 'alpha-bot',
      monthSpend: 12,
      monthlyBudgetUsd: 100,
      utilisation: 0.12,
    },
  ],
  byModel: [{ model: 'claude-sonnet-4-6', monthSpend: 15 }],
  trend: [{ date: '2026-04-10', totalCostUsd: 3.5 }],
  localSavings: null,
};

const MOCK_ALERTS = [
  {
    agentId: 'agent-2',
    name: 'Beta Bot',
    slug: 'beta-bot',
    monthlyBudgetUsd: 50,
    spent: 45,
    utilisation: 0.9,
    severity: 'critical',
  },
];

const MOCK_MODELS = [
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'mid',
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    maxContext: 200_000,
    supportsTools: true,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CostsPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Costs & Budget heading', async () => {
    // Arrange
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');

    // Mock all fetches to succeed. `globalCap` and `fetchedAt` mirror
    // the real AlertsResponse / ModelsResponse shapes — without them
    // the page reads `?? null` fallbacks and the corresponding UI
    // branches go untested.
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_SUMMARY }) // summary
      .mockResolvedValueOnce({
        success: true,
        data: { alerts: MOCK_ALERTS, globalCap: { cap: 100, spent: 60, exceeded: false } },
      }) // alerts
      .mockResolvedValueOnce({
        success: true,
        data: { rows: [], groupBy: 'model' },
      }) // perModel
      .mockResolvedValueOnce({
        success: true,
        data: { models: MOCK_MODELS, fetchedAt: 1715260800000 },
      }); // models

    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    // Act
    render(await CostsPage());

    // Assert: page heading
    expect(screen.getByRole('heading', { name: /costs & budget/i })).toBeInTheDocument();
  });

  it('renders all section containers under happy path', async () => {
    // Arrange
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');

    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_SUMMARY })
      .mockResolvedValueOnce({
        success: true,
        data: { alerts: MOCK_ALERTS, globalCap: { cap: 100, spent: 60, exceeded: false } },
      })
      .mockResolvedValueOnce({ success: true, data: { rows: [], groupBy: 'model' } })
      .mockResolvedValueOnce({
        success: true,
        data: { models: MOCK_MODELS, fetchedAt: 1715260800000 },
      });

    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    // Act
    render(await CostsPage());

    // Assert key sections by data-testid. The default-models /
    // settings form moved to the Settings page in this branch — the
    // Costs page now keeps only spend-reporting sections plus a
    // footer link to Settings.
    expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
    expect(screen.getByTestId('budget-alerts-list')).toBeInTheDocument();
    expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('per-agent-cost-table')).toBeInTheDocument();
    expect(screen.getByTestId('per-model-breakdown-table')).toBeInTheDocument();
    expect(screen.getByTestId('local-vs-cloud-panel')).toBeInTheDocument();
  });

  it('renders the global-cap-exceeded alert block when globalCap.exceeded is true', async () => {
    // Covers the BudgetAlertsList `hasGlobalCapAlert` branch — when
    // `globalCap.exceeded === true` the component renders a distinct
    // "Global monthly budget exceeded" block. Without globalCap in the
    // mock fixture this branch was unreachable.
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_SUMMARY })
      .mockResolvedValueOnce({
        success: true,
        data: {
          alerts: [],
          globalCap: { cap: 100, spent: 110, exceeded: true },
        },
      })
      .mockResolvedValueOnce({ success: true, data: { rows: [], groupBy: 'model' } })
      .mockResolvedValueOnce({
        success: true,
        data: { models: MOCK_MODELS, fetchedAt: 1715260800000 },
      });

    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(screen.getByText(/global monthly budget exceeded/i)).toBeInTheDocument();
  });

  it('renders stable empty-state layout when every fetch rejects, and logs each helper failure', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { logger } = await import('@/lib/logging');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network failure'));

    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    // Direct render — Vitest surfaces unhandled exceptions natively, so
    // a try/catch flag is redundant. The real contract: each failed
    // helper logs via logger.error AND the page still renders.
    render(await CostsPage());

    expect(screen.getByRole('heading', { name: /costs & budget/i })).toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(
      'costs page: failed to load cost summary',
      expect.any(Error)
    );
    expect(logger.error).toHaveBeenCalledWith(
      'costs page: failed to load budget alerts',
      expect.any(Error)
    );
    expect(logger.error).toHaveBeenCalledWith(
      'costs page: failed to load per-model breakdown',
      expect.any(Error)
    );
    expect(logger.error).toHaveBeenCalledWith(
      'costs page: failed to load models',
      expect.any(Error)
    );
  });

  it('renders the heading when serverFetch returns non-ok status (no helper throws, none log)', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { logger } = await import('@/lib/logging');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false, status: 500 } as Response);

    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(screen.getByRole('heading', { name: /costs & budget/i })).toBeInTheDocument();
    // Non-ok responses take the `if (!res.ok) return null` early-out
    // (NOT the catch arm) — so logger.error must NOT fire. Asserting
    // this distinguishes the "non-ok" path from the "throws" path
    // covered by the previous test.
    expect(logger.error).not.toHaveBeenCalled();
  });
});
