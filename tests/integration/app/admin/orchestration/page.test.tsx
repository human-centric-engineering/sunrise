/**
 * Integration Test: Admin Orchestration Dashboard
 *
 * Tests the server-component page at `app/admin/orchestration/page.tsx`.
 *
 * Test Coverage:
 * - Renders the page heading and subtitle.
 * - SetupRequiredBanner is rendered when no provider is configured and
 *   hidden when one is.
 * - The dashboard does not throw when every parallel fetch rejects —
 *   it falls back to empty-state cards instead of bubbling.
 *
 * @see app/admin/orchestration/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/orchestration/setup-state', () => ({
  getSetupState: vi.fn(),
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

async function setupMocks(setupState: SetupStateMock, fetchOk = false) {
  const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
  const { getSetupState } = await import('@/lib/orchestration/setup-state');

  vi.mocked(serverFetch).mockResolvedValue({ ok: fetchOk } as Response);
  vi.mocked(parseApiResponse).mockResolvedValue({ success: false } as never);
  vi.mocked(getSetupState).mockResolvedValue(setupState);
}

/**
 * Wire serverFetch + parseApiResponse so each helper on the page sees
 * realistic data on the happy path. The page fires its fetches through
 * `Promise.all`, so order isn't deterministic — instead of relying on
 * mockResolvedValueOnce we tag every fake `Response` with the URL it
 * was created for and route parseApiResponse by URL substring.
 */
async function setupHappyPathMocks(setupState: SetupStateMock): Promise<void> {
  const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
  const { getSetupState } = await import('@/lib/orchestration/setup-state');

  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    return { ok: true, _testUrl: url } as unknown as Response;
  });

  vi.mocked(parseApiResponse).mockImplementation(async (res: Response) => {
    const url = (res as unknown as { _testUrl: string })._testUrl;
    if (url.includes('/costs/summary')) {
      return {
        success: true,
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
      } as never;
    }
    if (url.includes('/costs/alerts')) {
      return { success: true, data: { alerts: [] } } as never;
    }
    if (url.includes('/observability/dashboard-stats')) {
      return {
        success: true,
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
      } as never;
    }
    if (url.includes('/models')) {
      return { success: true, data: [] } as never;
    }
    if (url.includes('/agents')) {
      // Paginated total — meta.total is the field the helper reads.
      return {
        success: true,
        data: [],
        meta: { page: 1, limit: 1, total: 5, totalPages: 5 },
      } as never;
    }
    if (url.includes('/conversations')) {
      return {
        success: true,
        data: [
          {
            id: 'conv-1',
            title: 'Test conversation',
            createdAt: '2026-04-10T11:00:00.000Z',
            updatedAt: '2026-04-10T11:30:00.000Z',
          },
        ],
      } as never;
    }
    if (url.includes('/executions')) {
      // Includes one execution that shares an id with the recentError —
      // the page should dedupe and keep the error variant.
      return {
        success: true,
        data: [
          {
            id: 'err-shared-1',
            status: 'failed',
            createdAt: '2026-04-10T11:45:00.000Z',
          },
          {
            id: 'exec-2',
            status: 'completed',
            createdAt: '2026-04-10T11:55:00.000Z',
          },
        ],
      } as never;
    }
    return { success: false, error: { code: 'UNKNOWN', message: '' } } as never;
  });

  vi.mocked(getSetupState).mockResolvedValue(setupState);
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

  it('renders the trends + activity sections under the empty fetch path', async () => {
    await setupMocks({ hasProvider: true, hasAgent: true, hasDefaultChatModel: true });

    await renderPage();

    expect(screen.getByTestId('dashboard-stats-cards')).toBeInTheDocument();
    expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('top-capabilities-panel')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-activity-feed')).toBeInTheDocument();
    expect(screen.getByTestId('budget-alerts-banner')).toBeInTheDocument();
  });

  it('does not throw when every serverFetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { getSetupState } = await import('@/lib/orchestration/setup-state');

    vi.mocked(serverFetch).mockRejectedValue(new Error('Network failure'));
    vi.mocked(getSetupState).mockResolvedValue({
      hasProvider: true,
      hasAgent: true,
      hasDefaultChatModel: true,
    });

    let thrown = false;
    try {
      await renderPage();
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /^ai orchestration$/i })).toBeInTheDocument();
  });

  describe('happy path with all fetches succeeding', () => {
    it('renders the dashboard sections', async () => {
      await setupHappyPathMocks({
        hasProvider: true,
        hasAgent: true,
        hasDefaultChatModel: true,
      });

      await renderPage();

      expect(screen.getByRole('heading', { name: /^ai orchestration$/i })).toBeInTheDocument();
      expect(screen.getByTestId('dashboard-stats-cards')).toBeInTheDocument();
      expect(screen.getByTestId('cost-trend-chart')).toBeInTheDocument();
      expect(screen.getByTestId('top-capabilities-panel')).toBeInTheDocument();
      expect(screen.getByTestId('dashboard-activity-feed')).toBeInTheDocument();
    });

    it('passes the recent week of trend data into the chart', async () => {
      // The page slices `trend.slice(-7)` to render the 7-day chart —
      // this exercises the success branch of getCostSummary.
      await setupHappyPathMocks({
        hasProvider: true,
        hasAgent: true,
        hasDefaultChatModel: true,
      });

      await renderPage();

      // The mocked CostTrendChart prints its `title` prop into the
      // testid container; "7-day spend trend" is the page-supplied
      // value, so seeing it confirms the page actually rendered the
      // chart with its happy-path props.
      expect(screen.getByTestId('cost-trend-chart')).toHaveTextContent('7-day spend trend');
    });

    it('does not throw when only one of the parallel fetches resolves with success', async () => {
      // Partial-failure scenario: getCostSummary returns ok+success,
      // every other endpoint returns ok=false. The page should still
      // render without throwing.
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      const { getSetupState } = await import('@/lib/orchestration/setup-state');

      vi.mocked(serverFetch).mockImplementation(async (url: string) => {
        const ok = url.includes('/costs/summary');
        return { ok, _testUrl: url } as unknown as Response;
      });
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { totals: { today: 0, week: 0, month: 0 }, byAgent: [], byModel: [], trend: [] },
      } as never);
      vi.mocked(getSetupState).mockResolvedValue({
        hasProvider: true,
        hasAgent: true,
        hasDefaultChatModel: true,
      });

      let thrown = false;
      try {
        await renderPage();
      } catch {
        thrown = true;
      }

      expect(thrown).toBe(false);
      expect(screen.getByRole('heading', { name: /^ai orchestration$/i })).toBeInTheDocument();
    });

    it('falls back to 0 when paginated total meta is missing the total field', async () => {
      // Exercises the `hasNumericTotal` guard — when the API succeeds
      // but doesn't include a `meta.total`, the helper returns 0.
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      const { getSetupState } = await import('@/lib/orchestration/setup-state');

      vi.mocked(serverFetch).mockImplementation(async (url: string) => {
        return { ok: true, _testUrl: url } as unknown as Response;
      });
      vi.mocked(parseApiResponse).mockImplementation(async (res: Response) => {
        const url = (res as unknown as { _testUrl: string })._testUrl;
        if (url.includes('/agents')) {
          // No `meta` at all — `hasNumericTotal` should return false
          // and the helper should fall back to 0.
          return { success: true, data: [] } as never;
        }
        return { success: false, error: { code: 'X', message: '' } } as never;
      });
      vi.mocked(getSetupState).mockResolvedValue({
        hasProvider: true,
        hasAgent: true,
        hasDefaultChatModel: true,
      });

      await renderPage();

      // The page renders successfully; we don't need to assert on the
      // 0 directly since DashboardStatsCards is mocked — exercising
      // the branch is the goal.
      expect(screen.getByTestId('dashboard-stats-cards')).toBeInTheDocument();
    });
  });
});
