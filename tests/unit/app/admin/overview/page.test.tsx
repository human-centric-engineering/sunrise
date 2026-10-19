// @vitest-environment happy-dom

/**
 * Unit Tests: AdminOverviewPage (app/admin/overview/page.tsx)
 *
 * The page's whole job is loading the stats and handing them to its children.
 * The stats are one panel among three, so a failed load (a 500, a
 * `success:false` body, no response at all) must not throw, and must not look
 * like data either (#518):
 * - the stat cards are replaced by a "Couldn't load" notice (`role="alert"`) —
 *   before #518 they rendered loading skeletons forever
 * - `SystemInfo` gets `null`, for which it renders an explicit "unavailable"
 *   message, so "the stats API is down" and "this deployment is fine" do not
 *   render the same
 * - happy path → the parsed stats reach the children
 *
 * Only `serverFetch` is faked: the real parser and `loadServerData` run.
 *
 * No auth-redirect test: the admin guard lives in `app/admin/layout.tsx`, which
 * has its own.
 *
 * @see app/admin/overview/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Stub the three children and record the `stats` each one received. Stubbing
// rather than rendering the real components keeps this about the page's own
// job — resolve stats, hand them on — and leaves each child's rendering to its
// own test file.
vi.mock('@/components/admin/stats-cards', () => ({
  StatsCards: (props: { stats: unknown }) => (
    <div data-testid="stats-cards" data-stats={JSON.stringify(props.stats)} />
  ),
}));

vi.mock('@/components/admin/system-info', () => ({
  SystemInfo: (props: { stats: unknown }) => (
    <div data-testid="system-info" data-stats={JSON.stringify(props.stats)} />
  ),
}));

vi.mock('@/components/status/status-page', () => ({
  StatusPage: (props: { title?: string }) => (
    <div data-testid="status-page" data-title={props.title} />
  ),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import AdminOverviewPage from '@/app/admin/overview/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';
import type { SystemStats } from '@/types/admin';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATS: SystemStats = {
  users: {
    total: 150,
    verified: 120,
    recentSignups: 5,
    byRole: { USER: 145, ADMIN: 5 },
  },
  system: {
    nodeVersion: 'v24.1.0',
    appVersion: '3.1.4',
    sunriseVersion: '0.9.0',
    environment: 'production',
    uptime: 86400,
    databaseStatus: 'connected',
  },
};

/** The `stats` prop a stubbed child received, parsed back out of the DOM. */
function statsPassedTo(testId: string): unknown {
  const raw = screen.getByTestId(testId).getAttribute('data-stats');
  return raw === null ? undefined : JSON.parse(raw);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminOverviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── A failed load is a failure, not data (#518) ─────────────────────────

  /** The failed-load notice must stand where the stat cards would be. */
  function expectStatsFailedNotice(): void {
    expect(screen.queryByTestId('stats-cards')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load user statistics/i);
    expect(statsPassedTo('system-info')).toBeNull();
  }

  it('shows a failed-load notice in place of the stat cards when the stats API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    render(await AdminOverviewPage());

    expectStatsFailedNotice();
    expect(logger.error).toHaveBeenCalled();
    // The rest of the dashboard still renders.
    expect(screen.getByTestId('status-page')).toBeInTheDocument();
  });

  it('shows the notice when the response body reports failure', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    render(await AdminOverviewPage());

    expectStatsFailedNotice();
  });

  it('shows the notice — and does not throw — when the fetch rejects', async () => {
    // A rejected promise, which is how `fetch` actually fails. One panel's
    // data source being down must not 500 the admin dashboard.
    const fetchErr = new Error('ECONNREFUSED');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);

    render(await AdminOverviewPage());

    expectStatsFailedNotice();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
  });

  // ── getStats: happy path ─────────────────────────────────────────────────

  it('hands the fetched stats to both StatsCards and SystemInfo', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(STATS));

    render(await AdminOverviewPage());

    // Asserted whole, not field-by-field: the page's contract is that it passes
    // the payload through unmodified, and a spot-check on one field would not
    // notice it dropping another.
    expect(statsPassedTo('stats-cards')).toEqual(STATS);
    expect(statsPassedTo('system-info')).toEqual(STATS);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads the admin stats endpoint, not some other route', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(STATS));

    render(await AdminOverviewPage());

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(API.ADMIN.STATS);
  });

  // ── Composition ──────────────────────────────────────────────────────────

  it('renders all three panels, including the version card', async () => {
    // `SystemInfo` is the whole operator-visibility half of #531. A page that
    // silently stopped rendering it would leave the platform version with no
    // surface at all, and every other assertion here would still pass.
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(STATS));

    render(await AdminOverviewPage());

    expect(screen.getByTestId('stats-cards')).toBeInTheDocument();
    expect(screen.getByTestId('status-page')).toBeInTheDocument();
    expect(screen.getByTestId('system-info')).toBeInTheDocument();
  });
});
