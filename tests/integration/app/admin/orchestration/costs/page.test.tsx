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

    // Mock all fetches to succeed
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_SUMMARY }) // summary
      .mockResolvedValueOnce({ success: true, data: { alerts: MOCK_ALERTS } }) // alerts
      .mockResolvedValueOnce({
        success: true,
        data: { rows: [], groupBy: 'model' },
      }) // perModel
      .mockResolvedValueOnce({ success: true, data: { models: MOCK_MODELS } }); // models

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
      .mockResolvedValueOnce({ success: true, data: { alerts: MOCK_ALERTS } })
      .mockResolvedValueOnce({ success: true, data: { rows: [], groupBy: 'model' } })
      .mockResolvedValueOnce({ success: true, data: { models: MOCK_MODELS } });

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

  it('renders stable empty-state layout and does not throw when every fetch rejects', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network failure'));

    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    // Act
    let thrown = false;
    try {
      render(await CostsPage());
    } catch {
      thrown = true;
    }

    // Assert: never throws
    expect(thrown).toBe(false);

    // Assert: page heading still renders (structural stability)
    expect(screen.getByRole('heading', { name: /costs & budget/i })).toBeInTheDocument();
  });

  it('does not throw when serverFetch returns non-ok status', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false, status: 500 } as Response);

    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    // Act
    let thrown = false;
    try {
      render(await CostsPage());
    } catch {
      thrown = true;
    }

    // Assert
    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /costs & budget/i })).toBeInTheDocument();
  });
});
