// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Costs & Budget Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/costs/page.tsx`.
 *
 * Test Coverage:
 * - Happy path: all 5 parallel fetches succeed, page sections render
 * - A failed summary load throws to the error boundary: the view would render
 *   it as "no spend" (#518)
 * - A failed alerts load shows a notice in the alerts panel's place, never
 *   "no agents over budget", and the rest of the page still renders
 * - A failed per-model, models or per-org load shows a "Couldn't load"
 *   notice and the rest of the page still renders; a 403 from /costs/orgs
 *   (the expected refusal) hides the table without one
 * - The per-org usage table renders from /costs/orgs (§110 t-790)
 *
 * @see app/admin/orchestration/costs/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
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
  unstable_rethrow: vi.fn(),
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

const ORG_REPORT = {
  period: '2026-10',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  orgs: [orgRow('acme', 'Acme', 5), orgRow('install', 'Install', 1)],
  detached: null,
  totals: { totalCostUsd: 6, inputTokens: 200, outputTokens: 20, count: 2 },
};

function orgRow(orgId: string, name: string, totalCostUsd: number) {
  return {
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
  };
}

const PATHS = {
  summary: '/api/v1/admin/orchestration/costs/summary',
  alerts: '/api/v1/admin/orchestration/costs/alerts',
  perModel: '/api/v1/admin/orchestration/costs',
  models: '/api/v1/admin/orchestration/models',
  orgs: '/api/v1/admin/orchestration/costs/orgs',
} as const;

type Source = keyof typeof PATHS;

// `globalCap` and `fetchedAt` mirror the real AlertsResponse / ModelsResponse
// shapes, so the UI branches that read them are exercised.
const HAPPY: Record<Source, unknown> = {
  summary: MOCK_SUMMARY,
  alerts: { alerts: MOCK_ALERTS, globalCap: { cap: 100, spent: 60, exceeded: false } },
  perModel: { rows: [], groupBy: 'model' },
  models: { models: MOCK_MODELS, fetchedAt: 1715260800000 },
  orgs: { ...ORG_REPORT, orgs: [orgRow('install', 'Install', 1)] },
};

/**
 * Route each fetch by path (query string stripped): five fetches race in
 * Promise.all. A source in `answers` gets that answer (a body, a Response,
 * or an Error to reject with); the rest get their happy body.
 */
async function answer(answers: Partial<Record<Source, unknown>> = {}) {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  vi.mocked(serverFetch).mockImplementation(async (path: string) => {
    const source = (Object.keys(PATHS) as Source[]).find((k) => PATHS[k] === path.split('?')[0]);
    if (!source) return apiFailure(404, 'NOT_FOUND');
    const given = source in answers ? answers[source] : HAPPY[source];
    if (given instanceof Error) throw given;
    if (given instanceof Response) return given;
    return apiSuccess(given);
  });
}

async function fetchedPaths(): Promise<string[]> {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  return vi.mocked(serverFetch).mock.calls.map((call) => call[0]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CostsPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Costs & Budget heading', async () => {
    await answer();
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(screen.getByRole('heading', { name: /costs & budget/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders all section containers under happy path', async () => {
    await answer();
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    // The default-models / settings form moved to the Settings page — the
    // Costs page keeps only spend-reporting sections plus a footer link.
    expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
    expect(screen.getByTestId('budget-alerts-list')).toBeInTheDocument();
    expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('per-agent-cost-table')).toBeInTheDocument();
    expect(screen.getByTestId('per-model-breakdown-table')).toBeInTheDocument();
    expect(screen.getByTestId('local-vs-cloud-panel')).toBeInTheDocument();
  });

  it('renders the global-cap-exceeded alert block when globalCap.exceeded is true', async () => {
    // Covers the BudgetAlertsList `hasGlobalCapAlert` branch.
    await answer({ alerts: { alerts: [], globalCap: { cap: 100, spent: 110, exceeded: true } } });
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(screen.getByText(/global monthly budget exceeded/i)).toBeInTheDocument();
  });

  // ── A failed load is a failure, not an empty state (#518) ────────────────

  it.each([
    ['summary', apiFailure(500)],
    ['summary', apiFailure(200)],
    ['summary', new Error('Network failure')],
  ] as const)(
    'throws to the error boundary when the %s load fails (%#)',
    async (source, failure) => {
      const { ServerLoadError } = await import('@/lib/api/server-load');
      const { logger } = await import('@/lib/logging');
      await answer({ [source]: failure });
      const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

      await expect(CostsPage()).rejects.toBeInstanceOf(ServerLoadError);
      expect(logger.error).toHaveBeenCalled();
    }
  );

  it.each([
    ['a 500', apiFailure(500)],
    ['a rejected fetch', new Error('Network failure')],
  ] as const)(
    'shows a notice in the alerts panel’s place on %s, and still renders the rest',
    async (_label, failure) => {
      const { logger } = await import('@/lib/logging');
      await answer({ alerts: failure });
      const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

      render(await CostsPage());

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load budget alerts");
      expect(screen.queryByTestId('budget-alerts-list')).not.toBeInTheDocument();
      expect(screen.queryByText(/no agents are currently over 80%/i)).not.toBeInTheDocument();
      expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
      expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
      // The per-agent table still renders from the summary.
      expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
      expect(screen.queryByText('Beta Bot')).not.toBeInTheDocument();
      expect(logger.error).toHaveBeenCalled();
    }
  );

  it.each([
    ['perModel', 'the per-model spend breakdown'],
    ['models', 'the model registry'],
    ['orgs', 'per-organisation usage'],
  ] as const)(
    'shows a notice when the %s load fails, and still renders the rest',
    async (source, what) => {
      const { logger } = await import('@/lib/logging');
      await answer({ [source]: apiFailure(500) });
      const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

      render(await CostsPage());

      expect(screen.getByRole('alert')).toHaveTextContent(`Couldn't load ${what}`);
      expect(screen.getByTestId('cost-summary-cards')).toBeInTheDocument();
      expect(screen.getByText('Beta Bot')).toBeInTheDocument();
      expect(logger.error).toHaveBeenCalled();
    }
  );

  it('hides the per-org table without a notice when /costs/orgs refuses (403)', async () => {
    await answer({ orgs: apiFailure(403, 'FORBIDDEN') });
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('per-org-usage-table')).not.toBeInTheDocument();
    // The refusal is the expected answer for this viewer, so nothing is logged.
    const { logger } = await import('@/lib/logging');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('renders a real month with no spend as empty, with no notice', async () => {
    await answer({
      summary: { ...MOCK_SUMMARY, byAgent: [], byModel: [], trend: [] },
      alerts: { alerts: [], globalCap: { cap: null, spent: null, exceeded: false } },
    });
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(screen.getByText('No agent spend recorded this month.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the per-org usage table from /costs/orgs when there is more than one org', async () => {
    await answer({ orgs: ORG_REPORT });
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(await fetchedPaths()).toContain(PATHS.orgs);
    expect(screen.getByTestId('per-org-usage-table')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute('href', '/admin/orgs/acme');
  });
});

describe('CostsPage — an org admin’s half (§111 t-812)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    viewer.tier = 'org';
    // Every route answers, the per-org one included, so a page that still
    // fetched and rendered it would show it.
    await answer({
      alerts: { alerts: MOCK_ALERTS, globalCap: { cap: null, spent: null, exceeded: false } },
      orgs: ORG_REPORT,
    });
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
    const { default: CostsPage } = await import('@/app/admin/orchestration/costs/page');

    render(await CostsPage());

    expect(await fetchedPaths()).not.toContain(PATHS.orgs);
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
