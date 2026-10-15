// @vitest-environment happy-dom

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
 * - An envelope with success: false is treated as not loaded
 * - The per-org usage table renders from /costs/orgs (§110 t-790)
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

  useSearchParams: () => ({ get: () => null }),
}));

// CostsPage's server component awaits refreshFromOpenRouter() before
// rendering. Without this mock every test fires a real 10-second HTTP
// request to openrouter.ai — flake risk and CI dependency on a third
// party. The route under test exercises cost summary fetching, not
// the model registry refresh, so a no-op resolution is the right stub.
vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  refreshFromOpenRouter: vi.fn(() => Promise.resolve()),
}));

// Who is viewing (§111 t-812). Every case before the last describe is the
// platform's view, as it was before the page asked; the org viewer's half is
// the last describe's.
const viewer = vi.hoisted(() => ({ tier: 'platform' }));
vi.mock('@/lib/auth/admin-page-viewer', () => ({
  adminPageViewerTier: vi.fn(() => Promise.resolve(viewer.tier)),
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

  it('treats an envelope with success: false as not loaded, without logging', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    const { logger } = await import('@/lib/logging');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });

    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(screen.getByRole('heading', { name: /costs & budget/i })).toBeInTheDocument();
    expect(screen.getByText('No agent spend recorded this month.')).toBeInTheDocument();
    expect(screen.queryByTestId('per-org-usage-table')).not.toBeInTheDocument();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('renders the per-org usage table from /costs/orgs when there is more than one org', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    const orgRow = (orgId: string, name: string, totalCostUsd: number) => ({
      orgId,
      name,
      slug: orgId,
      status: 'ACTIVE',
      totalCostUsd,
      inputTokens: 100,
      outputTokens: 10,
      count: 1,
      monthlyBudgetUsd: null,
      utilisation: null,
    });
    const bodies: Record<string, unknown> = {
      '/api/v1/admin/orchestration/costs/orgs': {
        period: '2026-10',
        periodStart: '2026-10-01T00:00:00.000Z',
        periodEnd: '2026-11-01T00:00:00.000Z',
        orgs: [orgRow('acme', 'Acme', 5), orgRow('install', 'Install', 1)],
        detached: null,
        totals: { totalCostUsd: 6, inputTokens: 200, outputTokens: 20, count: 2 },
      },
    };
    // Keyed by path rather than call order: five fetches race in Promise.all.
    vi.mocked(serverFetch).mockImplementation(
      async (path: string) => ({ ok: path in bodies, path }) as unknown as Response
    );
    vi.mocked(parseApiResponse).mockImplementation((async (res: { path: string }) => ({
      success: true,
      data: bodies[res.path],
    })) as never);

    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(serverFetch).toHaveBeenCalledWith('/api/v1/admin/orchestration/costs/orgs');
    expect(screen.getByTestId('per-org-usage-table')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute('href', '/admin/orgs/acme');
  });
});

describe('CostsPage — an org admin’s half (§111 t-812)', () => {
  const orgRow = (orgId: string, name: string, totalCostUsd: number) => ({
    orgId,
    name,
    slug: orgId,
    status: 'ACTIVE',
    totalCostUsd,
    inputTokens: 100,
    outputTokens: 10,
    count: 1,
    monthlyBudgetUsd: null,
    utilisation: null,
  });
  // Every route answers, the per-org one included, so a page that still
  // fetched and rendered it would show it.
  const bodies: Record<string, unknown> = {
    '/api/v1/admin/orchestration/costs/summary': MOCK_SUMMARY,
    '/api/v1/admin/orchestration/costs/alerts': {
      alerts: MOCK_ALERTS,
      globalCap: { cap: null, spent: null, exceeded: false },
    },
    '/api/v1/admin/orchestration/models': { models: MOCK_MODELS, fetchedAt: 1715260800000 },
    '/api/v1/admin/orchestration/costs/orgs': {
      period: '2026-10',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      orgs: [orgRow('acme', 'Acme', 5), orgRow('install', 'Install', 1)],
      detached: null,
      totals: { totalCostUsd: 6, inputTokens: 200, outputTokens: 20, count: 2 },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    viewer.tier = 'org';
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockImplementation(
      async (path: string) => ({ ok: path in bodies, path }) as unknown as Response
    );
    vi.mocked(parseApiResponse).mockImplementation((async (res: { path: string }) => ({
      success: true,
      data: bodies[res.path],
    })) as never);
  });

  afterEach(() => {
    viewer.tier = 'platform';
    vi.restoreAllMocks();
  });

  it('shows the org’s spend: summary, alerts, per-agent and per-model', async () => {
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
    expect(screen.getByTestId('budget-alerts-list')).toBeInTheDocument();
    expect(screen.getByTestId('per-agent-cost-table')).toBeInTheDocument();
    expect(screen.getByTestId('per-model-breakdown-table')).toBeInTheDocument();
    expect(screen.getByText('Beta Bot')).toBeInTheDocument();
  });

  it('neither fetches nor shows each org’s usage, nor links to the budget settings', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(serverFetch).not.toHaveBeenCalledWith('/api/v1/admin/orchestration/costs/orgs');
    expect(screen.queryByTestId('per-org-usage-table')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open settings/i })).not.toBeInTheDocument();
  });

  it('control: the platform’s view of the same answers has both', async () => {
    viewer.tier = 'platform';
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(screen.getByTestId('per-org-usage-table')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open settings/i })).toBeInTheDocument();
  });
});
