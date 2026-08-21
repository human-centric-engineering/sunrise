// @vitest-environment happy-dom

/**
 * Unit Tests: AdminOverviewPage (app/admin/overview/page.tsx)
 *
 * The page had no test at all before #531 put `SystemInfo` on it. Its whole job
 * is `getStats()` — three failure branches that all collapse to `null` — and
 * then handing that one value to three children. So the branches ARE the page,
 * and an untested `getStats()` is an untested page.
 *
 * What each branch has to hold:
 * - `res.ok` false → `null`
 * - `body.success` false → `null`
 * - `serverFetch` throws → `null` (the `catch` — a rejected promise, not a
 *   thrown-synchronously error, because that is how a fetch fails)
 * - happy path → the parsed stats reach the children
 *
 * `null` matters more here than it looks: `SystemInfo` renders an explicit
 * "unavailable" message for it rather than an empty card, so "the stats API is
 * down" and "this deployment is fine" must not render the same. That is the
 * property these tests pin, on the page an operator opens *because* something is
 * wrong.
 *
 * No auth-redirect test: the admin guard lives in `app/admin/layout.tsx`, which
 * has its own.
 *
 * @see app/admin/overview/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
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

function okResponse(): Response {
  return { ok: true } as Response;
}

function notOkResponse(): Response {
  return { ok: false } as Response;
}

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

  // ── getStats: the three ways it yields null ──────────────────────────────

  it('passes null to the children when the stats response is not ok', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    render(await AdminOverviewPage());

    expect(statsPassedTo('system-info')).toBeNull();
    expect(statsPassedTo('stats-cards')).toBeNull();
    // `parseApiResponse` must not even be reached — the page returns on `!res.ok`.
    expect(parseApiResponse).not.toHaveBeenCalled();
  });

  it('passes null to the children when the response body reports failure', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'fail' },
    } as never);

    render(await AdminOverviewPage());

    expect(statsPassedTo('system-info')).toBeNull();
    expect(statsPassedTo('stats-cards')).toBeNull();
  });

  it('passes null to the children — and does not throw — when the fetch rejects', async () => {
    // A rejected promise, which is how `fetch` actually fails. The page's
    // `catch` has to swallow it: an unhandled rejection here is a 500 on the
    // admin dashboard because one panel's data source is down.
    vi.mocked(serverFetch).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(AdminOverviewPage()).resolves.toBeTruthy();

    render(await AdminOverviewPage());
    expect(statsPassedTo('system-info')).toBeNull();
  });

  // ── getStats: happy path ─────────────────────────────────────────────────

  it('hands the fetched stats to both StatsCards and SystemInfo', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: STATS,
    } as never);

    render(await AdminOverviewPage());

    // Asserted whole, not field-by-field: the page's contract is that it passes
    // the payload through unmodified, and a spot-check on one field would not
    // notice it dropping another.
    expect(statsPassedTo('stats-cards')).toEqual(STATS);
    expect(statsPassedTo('system-info')).toEqual(STATS);
  });

  it('reads the admin stats endpoint, not some other route', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: STATS } as never);

    render(await AdminOverviewPage());

    expect(serverFetch).toHaveBeenCalledWith(API.ADMIN.STATS);
  });

  // ── Composition ──────────────────────────────────────────────────────────

  it('renders all three panels, including the version card', async () => {
    // `SystemInfo` is the whole operator-visibility half of #531. A page that
    // silently stopped rendering it would leave the platform version with no
    // surface at all, and every other assertion here would still pass.
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: STATS } as never);

    render(await AdminOverviewPage());

    expect(screen.getByTestId('stats-cards')).toBeInTheDocument();
    expect(screen.getByTestId('status-page')).toBeInTheDocument();
    expect(screen.getByTestId('system-info')).toBeInTheDocument();
  });
});
