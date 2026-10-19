// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration Dashboard
 *
 * Tests the server-component page at `app/admin/orchestration/page.tsx`.
 *
 * Test Coverage:
 * - Renders the page heading and subtitle.
 * - SetupRequiredBanner is rendered when no provider is configured and
 *   hidden when one is.
 * - The dashboard does not throw when a fetch fails, and never shows a
 *   failed panel as an empty one: each failed panel renders a "Couldn't
 *   load" notice in its place (#518).
 *
 * @see app/admin/orchestration/page.tsx
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

vi.mock('@/lib/orchestration/setup-state', () => ({
  getSetupState: vi.fn(),
}));

// Who is viewing (§111 t-812). Every case before the last describe is the
// platform's view, as it was before the page asked; the org viewer's half is
// the last describe's.
const viewer = vi.hoisted(() => ({ tier: 'platform' }));
vi.mock('@/lib/auth/admin-page-viewer', () => ({
  adminPageViewerTier: vi.fn(() => Promise.resolve(viewer.tier)),
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

// Heavy chart / feed children are exercised by their own component
// tests; here we replace them with stubs so this test stays focused
// on what the dashboard *page* is responsible for: composing children,
// computing the setup-banner gate, and surviving fetch failure.
vi.mock('@/components/admin/orchestration/costs/cost-trend-chart', () => ({
  CostTrendChart: ({ title }: { title?: string }) => (
    <div data-testid="cost-trend-chart">{title ?? ''}</div>
  ),
}));

vi.mock('@/components/admin/orchestration/dashboard-activity-feed', () => ({
  DashboardActivityFeed: () => <div data-testid="dashboard-activity-feed" />,
}));

vi.mock('@/components/admin/orchestration/dashboard-stats-cards', () => ({
  DashboardStatsCards: () => <div data-testid="dashboard-stats-cards" />,
}));

vi.mock('@/components/admin/orchestration/top-capabilities-panel', () => ({
  TopCapabilitiesPanel: () => <div data-testid="top-capabilities-panel" />,
}));

vi.mock('@/components/admin/orchestration/budget-alerts-banner', () => ({
  BudgetAlertsBanner: () => <div data-testid="budget-alerts-banner" />,
}));

vi.mock('@/components/admin/orchestration/setup-wizard-launcher', () => ({
  SetupWizardLauncher: ({ forceOpen }: { forceOpen?: boolean }) => (
    <div data-testid="setup-wizard-launcher" data-force-open={forceOpen ? 'true' : 'false'} />
  ),
}));

// SetupRequiredBanner is intentionally NOT mocked — its presence /
// absence is the gate this test verifies.

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SetupStateMock {
  hasProvider: boolean;
  hasAgent: boolean;
  hasDefaultChatModel: boolean;
}

/** Every fetch fails with a 500; only the setup state (a direct read) loads. */
async function setupMocks(setupState: SetupStateMock) {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  const { getSetupState } = await import('@/lib/orchestration/setup-state');

  vi.mocked(serverFetch).mockImplementation(async () => apiFailure(500));
  vi.mocked(getSetupState).mockResolvedValue(setupState);
}

/** Happy-path bodies, routed by URL substring (the page fetches in parallel). */
const HAPPY_BODIES: Array<{ match: string; data: unknown; meta?: unknown }> = [
  {
    match: '/costs/summary',
    data: {
      totals: { today: 1.5, week: 7, month: 22 },
      byAgent: [],
      byModel: [],
      trend: [
        { date: '2026-04-01', totalCostUsd: 1 },
        { date: '2026-04-02', totalCostUsd: 2 },
      ],
      localSavings: null,
    },
  },
  { match: '/costs/alerts', data: { alerts: [] } },
  {
    match: '/observability/dashboard-stats',
    data: {
      activeConversations: 3,
      todayRequests: 12,
      errorRate: 0.05,
      recentErrors: [
        {
          id: 'err-shared-1',
          errorMessage: 'capability timeout',
          workflowId: 'wf-1',
          createdAt: '2026-04-10T12:00:00.000Z',
        },
      ],
      topCapabilities: [],
    },
  },
  { match: '/active-quarantines', data: { items: [] } },
  // The real endpoint returns `{ models, refreshed, fetchedAt }`, not a flat
  // array, so the page's unwrap (`body.data.models`) is exercised.
  { match: '/models', data: { models: [], refreshed: false, fetchedAt: 0 } },
  // Paginated total — meta.total is the field the helper reads.
  { match: '/agents', data: [], meta: { page: 1, limit: 1, total: 5, totalPages: 5 } },
  {
    match: '/conversations',
    data: [
      {
        id: 'conv-1',
        title: 'Test conversation',
        createdAt: '2026-04-10T11:00:00.000Z',
        updatedAt: '2026-04-10T11:30:00.000Z',
      },
    ],
  },
  {
    // Includes one execution that shares an id with the recentError — the
    // page should dedupe and keep the error variant.
    match: '/executions',
    data: [
      { id: 'err-shared-1', status: 'failed', createdAt: '2026-04-10T11:45:00.000Z' },
      { id: 'exec-2', status: 'completed', createdAt: '2026-04-10T11:55:00.000Z' },
    ],
  },
];

/**
 * Answer each URL with its happy-path body, except the ones `failing` names,
 * which answer 500.
 */
async function setupHappyPathMocks(
  setupState: SetupStateMock,
  failing: string[] = []
): Promise<void> {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  const { getSetupState } = await import('@/lib/orchestration/setup-state');

  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (failing.some((f) => url.includes(f))) return apiFailure(500);
    const body = HAPPY_BODIES.find((b) => url.includes(b.match));
    return body ? apiSuccess(body.data, body.meta) : apiFailure(404, 'NOT_FOUND');
  });
  vi.mocked(getSetupState).mockResolvedValue(setupState);
}

const ALL_CONFIGURED = { hasProvider: true, hasAgent: true, hasDefaultChatModel: true };

function failedNotices(): string[] {
  return screen.queryAllByRole('alert').map((el) => el.textContent ?? '');
}

async function renderPage(): Promise<void> {
  const { default: OrchestrationDashboardPage } = await import('@/app/admin/orchestration/page');
  render(await OrchestrationDashboardPage());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OrchestrationDashboardPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the AI Orchestration heading and subtitle', async () => {
    await setupMocks({ hasProvider: true, hasAgent: true, hasDefaultChatModel: true });

    await renderPage();

    expect(screen.getByRole('heading', { name: /^ai orchestration$/i })).toBeInTheDocument();
    expect(screen.getByText(/operational overview/i)).toBeInTheDocument();
  });

  it('mounts the SetupRequiredBanner when hasProvider is false', async () => {
    await setupMocks({ hasProvider: false, hasAgent: false, hasDefaultChatModel: false });

    await renderPage();

    expect(screen.getByTestId('setup-required-banner')).toBeInTheDocument();
  });

  it('hides the SetupRequiredBanner when hasProvider is true', async () => {
    await setupMocks({ hasProvider: true, hasAgent: false, hasDefaultChatModel: false });

    await renderPage();

    expect(screen.queryByTestId('setup-required-banner')).not.toBeInTheDocument();
  });

  it('forwards forceOpen to SetupWizardLauncher when there is no provider', async () => {
    await setupMocks({ hasProvider: false, hasAgent: false, hasDefaultChatModel: false });

    await renderPage();

    expect(screen.getByTestId('setup-wizard-launcher')).toHaveAttribute('data-force-open', 'true');
  });

  it('keeps SetupWizardLauncher closed by default once a provider is configured', async () => {
    await setupMocks({ hasProvider: true, hasAgent: true, hasDefaultChatModel: true });

    await renderPage();

    expect(screen.getByTestId('setup-wizard-launcher')).toHaveAttribute('data-force-open', 'false');
  });

  it('shows a failure notice in place of every panel when every fetch fails', async () => {
    await setupMocks(ALL_CONFIGURED);

    await renderPage();

    // The stat cards show "—" for what they could not load, so they stay.
    expect(screen.getByTestId('dashboard-stats-cards')).toBeInTheDocument();
    // Every other panel is replaced, not rendered empty: an empty quarantine
    // panel or no budget banner is the all-clear signal.
    for (const id of [
      'cost-trend-chart',
      'top-capabilities-panel',
      'dashboard-activity-feed',
      'budget-alerts-banner',
    ]) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    expect(failedNotices()).toEqual([
      expect.stringContaining('budget alerts'),
      expect.stringContaining('capability quarantines'),
      expect.stringContaining('the spend trend'),
      expect.stringContaining('capability usage'),
      expect.stringContaining('recent activity'),
    ]);
  });

  it('does not throw when every serverFetch rejects, and says what failed', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { getSetupState } = await import('@/lib/orchestration/setup-state');

    vi.mocked(serverFetch).mockRejectedValue(new Error('Network failure'));
    vi.mocked(getSetupState).mockResolvedValue(ALL_CONFIGURED);

    await renderPage();

    expect(screen.getByRole('heading', { name: /^ai orchestration$/i })).toBeInTheDocument();
    expect(failedNotices()).toHaveLength(5);
  });

  describe('happy path with all fetches succeeding', () => {
    it('renders the dashboard sections', async () => {
      await setupHappyPathMocks(ALL_CONFIGURED);

      await renderPage();

      expect(screen.getByRole('heading', { name: /^ai orchestration$/i })).toBeInTheDocument();
      expect(screen.getByTestId('dashboard-stats-cards')).toBeInTheDocument();
      expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
      expect(screen.getByTestId('top-capabilities-panel')).toBeInTheDocument();
      expect(screen.getByTestId('dashboard-activity-feed')).toBeInTheDocument();
    });

    it("counts only the org's own agents, not its platform agents (§116 t-725)", async () => {
      await setupHappyPathMocks(ALL_CONFIGURED);

      await renderPage();

      const { serverFetch } = await import('@/lib/api/server-fetch');
      const agentUrls = vi
        .mocked(serverFetch)
        .mock.calls.map(([url]) => String(url))
        .filter((url) => url.includes('/orchestration/agents'));
      expect(agentUrls).toEqual([
        '/api/v1/admin/orchestration/agents?isSystem=false&page=1&limit=1',
      ]);
    });

    it('passes the recent week of trend data into the chart', async () => {
      // The page slices `trend.slice(-7)` to render the 7-day chart —
      // this exercises the success branch of getCostSummary.
      await setupHappyPathMocks(ALL_CONFIGURED);

      await renderPage();

      // The mocked CostTrendChart prints its `title` prop into the
      // testid container; "7-day spend trend" is the page-supplied
      // value, so seeing it confirms the page actually rendered the
      // chart with its happy-path props.
      expect(screen.getByTestId('cost-trend-chart')).toHaveTextContent('7-day spend trend');
    });

    it('shows a notice only for the panel whose fetch failed', async () => {
      await setupHappyPathMocks(ALL_CONFIGURED, ['/costs/alerts']);

      await renderPage();

      expect(screen.queryByTestId('budget-alerts-banner')).not.toBeInTheDocument();
      expect(failedNotices()).toEqual([expect.stringContaining('budget alerts')]);
      expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
      expect(screen.getByTestId('dashboard-activity-feed')).toBeInTheDocument();
    });

    it('shows the activity feed as failed when one of its sources fails', async () => {
      // A feed missing executions would read as "no recent runs".
      await setupHappyPathMocks(ALL_CONFIGURED, ['/executions']);

      await renderPage();

      expect(screen.queryByTestId('dashboard-activity-feed')).not.toBeInTheDocument();
      expect(failedNotices()).toEqual([expect.stringContaining('recent activity')]);
    });

    it('shows quarantines as failed, not all-clear, when the reply has no items list', async () => {
      const { serverFetch } = await import('@/lib/api/server-fetch');
      const { logger } = await import('@/lib/logging');
      await setupHappyPathMocks(ALL_CONFIGURED);
      const happy = vi.mocked(serverFetch).getMockImplementation();
      vi.mocked(serverFetch).mockImplementation(async (url: string, init?: RequestInit) =>
        url.includes('/active-quarantines') ? apiSuccess({}) : happy!(url, init)
      );

      await renderPage();

      expect(failedNotices()).toEqual([expect.stringContaining('capability quarantines')]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('no items list'),
        undefined,
        expect.any(Object)
      );
    });

    it('starts the activity feed fetches without waiting for the dashboard stats', async () => {
      const { serverFetch } = await import('@/lib/api/server-fetch');
      await setupHappyPathMocks(ALL_CONFIGURED);
      const happy = vi.mocked(serverFetch).getMockImplementation();
      let releaseStats!: () => void;
      const statsHeld = new Promise<void>((resolve) => {
        releaseStats = resolve;
      });
      vi.mocked(serverFetch).mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/dashboard-stats')) await statsHeld;
        return happy!(url, init);
      });
      const { default: OrchestrationDashboardPage } =
        await import('@/app/admin/orchestration/page');

      const rendering = OrchestrationDashboardPage();
      await vi.waitFor(() => {
        const urls = vi.mocked(serverFetch).mock.calls.map(([url]) => url);
        expect(urls.some((url) => url.includes('/conversations'))).toBe(true);
        expect(urls.some((url) => url.includes('/executions'))).toBe(true);
      });
      releaseStats();
      render(await rendering);

      expect(screen.getByTestId('dashboard-activity-feed')).toBeInTheDocument();
    });

    it('falls back to 0 when paginated total meta is missing the total field', async () => {
      // Exercises the `hasNumericTotal` guard — when the API succeeds but
      // doesn't include a `meta.total`, the helper returns 0.
      const { serverFetch } = await import('@/lib/api/server-fetch');
      await setupHappyPathMocks(ALL_CONFIGURED);
      const happy = vi.mocked(serverFetch).getMockImplementation();
      vi.mocked(serverFetch).mockImplementation(async (url: string, init?: RequestInit) =>
        url.includes('/agents') ? apiSuccess([]) : happy!(url, init)
      );

      await renderPage();

      // DashboardStatsCards is mocked, so exercising the branch is the goal.
      expect(screen.getByTestId('dashboard-stats-cards')).toBeInTheDocument();
      expect(failedNotices()).toEqual([]);
    });
  });
});

describe('OrchestrationDashboardPage — an org admin’s half (§111 t-812)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viewer.tier = 'org';
  });

  afterEach(() => {
    viewer.tier = 'platform';
    vi.restoreAllMocks();
  });

  async function fetchedUrls(): Promise<string[]> {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    return vi.mocked(serverFetch).mock.calls.map(([url]) => String(url));
  }

  it('shows the org’s stats, spend and activity', async () => {
    await setupHappyPathMocks({ hasProvider: true, hasAgent: true, hasDefaultChatModel: true });

    await renderPage();

    expect(screen.getByTestId('dashboard-stats-cards')).toBeInTheDocument();
    expect(screen.getByTestId('budget-alerts-banner')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-activity-feed')).toBeInTheDocument();
    const urls = await fetchedUrls();
    expect(urls.some((u) => u.includes('/costs/summary'))).toBe(true);
    expect(urls.some((u) => u.includes('/observability/dashboard-stats'))).toBe(true);
  });

  it('neither fetches nor renders the setup wizard, setup banner or quarantines', async () => {
    const { getSetupState } = await import('@/lib/orchestration/setup-state');
    // No provider: the platform's view would force the wizard open and show the banner.
    await setupHappyPathMocks({ hasProvider: false, hasAgent: false, hasDefaultChatModel: false });

    await renderPage();

    expect(screen.queryByTestId('setup-wizard-launcher')).not.toBeInTheDocument();
    expect(screen.queryByTestId('setup-required-banner')).not.toBeInTheDocument();
    expect(getSetupState).not.toHaveBeenCalled();
    expect((await fetchedUrls()).some((u) => u.includes('/active-quarantines'))).toBe(false);
  });

  it('control: the platform’s view of the same data has all three', async () => {
    viewer.tier = 'platform';
    const { getSetupState } = await import('@/lib/orchestration/setup-state');
    await setupHappyPathMocks({ hasProvider: false, hasAgent: false, hasDefaultChatModel: false });

    await renderPage();

    expect(screen.getByTestId('setup-wizard-launcher')).toHaveAttribute('data-force-open', 'true');
    expect(screen.getByTestId('setup-required-banner')).toBeInTheDocument();
    expect(getSetupState).toHaveBeenCalled();
    expect((await fetchedUrls()).some((u) => u.includes('/active-quarantines'))).toBe(true);
  });
});
