// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Executions list page
 *
 * Tests the server-component page at `app/admin/orchestration/executions/page.tsx`:
 * its three reads (the executions page, the live-engine snapshot, the
 * stuck-step threshold), what a failed read does — a failed list throws to
 * the error boundary rather than showing an empty list, and a failed snapshot
 * reaches the view as `null`, never as zero counts (#518) — and the org
 * admin's half (§111 t-812) — the table alone, with no live-engine snapshot
 * fetched.
 *
 * The client shell is replaced with a stub that records its props; its own
 * behaviour is `executions-list-view.test.tsx`'s.
 *
 * @see app/admin/orchestration/executions/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: vi.fn(),
}));

const viewer = vi.hoisted(() => ({ tier: 'platform' }));
vi.mock('@/lib/auth/admin-page-viewer', () => ({
  adminPageViewerTier: vi.fn(() => Promise.resolve(viewer.tier)),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/components/admin/orchestration/executions-list-view', () => ({
  ExecutionsListView: (props: {
    initialSnapshot: { running: { count: number } } | null;
    initialExecutions: { id: string }[];
    initialMeta: { total: number };
    initialWorkflowId?: string;
    initialStatus?: string;
    stuckThresholdMins: number;
    viewerTier?: string;
  }) => (
    <div
      data-testid="executions-list-view"
      data-running={props.initialSnapshot ? props.initialSnapshot.running.count : 'failed'}
      data-executions={props.initialExecutions.map((e) => e.id).join(',')}
      data-total={props.initialMeta.total}
      data-workflow-id={props.initialWorkflowId ?? ''}
      data-status={props.initialStatus ?? ''}
      data-threshold={props.stuckThresholdMins}
      data-viewer-tier={props.viewerTier ?? ''}
    />
  ),
}));

import ExecutionsListPage from '@/app/admin/orchestration/executions/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const SNAPSHOT = {
  running: { count: 3, p95AgeMs: 100, maxAgeMs: 200 },
  queued: { count: 1, maxWaitMs: 50 },
  orphaned: { count: 0 },
  providers: [],
  generatedAt: '2026-10-15T12:00:00.000Z',
};
const META = { page: 1, limit: 25, total: 2, totalPages: 1 };

const isSnapshot = (url: string) =>
  url.startsWith(API.ADMIN.ORCHESTRATION.EXECUTIONS_LIVE_SNAPSHOT);

/** Answer both reads; either can be replaced with a failure. */
function answer(
  overrides: { list?: () => Promise<Response>; snapshot?: () => Promise<Response> } = {}
): void {
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (isSnapshot(url)) return overrides.snapshot ? overrides.snapshot() : apiSuccess(SNAPSHOT);
    return overrides.list
      ? overrides.list()
      : apiSuccess([{ id: 'exec-1' }, { id: 'exec-2' }], META);
  });
}

const fetched = () => vi.mocked(serverFetch).mock.calls.map(([url]) => String(url));
const page = (params: Record<string, string> = {}) =>
  ExecutionsListPage({ searchParams: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  viewer.tier = 'platform';
  vi.mocked(getOrchestrationSettings).mockResolvedValue({
    stuckExecutionThresholdMins: 7,
  } as never);
});

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';

describe('ExecutionsListPage — the platform’s view', () => {
  it('hands the executions, the live snapshot and the threshold to the view', async () => {
    answer();

    render(await page());

    const view = screen.getByTestId('executions-list-view');
    expect(view).toHaveAttribute('data-executions', 'exec-1,exec-2');
    expect(view).toHaveAttribute('data-total', '2');
    expect(view).toHaveAttribute('data-running', '3');
    expect(view).toHaveAttribute('data-threshold', '7');
    expect(view).toHaveAttribute('data-viewer-tier', 'platform');
    expect(
      screen.getByText('In-flight engine state plus past execution runs.')
    ).toBeInTheDocument();
  });

  it('passes the workflow and status filters to the list read, and drops status=all', async () => {
    answer();

    render(await page({ workflowId: WORKFLOW_ID, status: 'failed' }));
    expect(fetched()[0]).toBe(
      `${API.ADMIN.ORCHESTRATION.EXECUTIONS}?page=1&limit=25&workflowId=${WORKFLOW_ID}&status=failed`
    );
    expect(screen.getByTestId('executions-list-view')).toHaveAttribute('data-status', 'failed');

    vi.mocked(serverFetch).mockClear();
    render(await page({ status: 'all' }));
    expect(fetched()[0]).toBe(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?page=1&limit=25`);
  });

  // The list route answers these with a 400, and the list is required: passed
  // through, a stale bookmark would be an error page "Try again" cannot clear.
  it('drops a malformed workflowId or an unknown status rather than sending them', async () => {
    answer();

    render(await page({ workflowId: 'not-a-cuid', status: 'nonsense' }));

    expect(fetched()[0]).toBe(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?page=1&limit=25`);
    expect(screen.getByTestId('executions-list-view')).toHaveAttribute('data-status', '');
    // The URL still names the filters, so the page says they were ignored.
    expect(screen.getByRole('status')).toHaveTextContent(
      "The link's workflow and status filters aren't valid, so they were ignored."
    );
  });

  it('names a single ignored filter', async () => {
    answer();

    render(await page({ status: 'nonsense' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      "The link's status filter isn't valid, so it was ignored. Showing all executions."
    );
  });

  it('says nothing about filters when they are valid or status=all', async () => {
    answer();

    render(await page({ workflowId: WORKFLOW_ID, status: 'all' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('throws to the error boundary, not an empty table, when the list read fails', async () => {
    answer({ list: async () => apiFailure(500) });

    await expect(page()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws the same when the list envelope says success: false', async () => {
    answer({ list: async () => apiFailure(200) });

    await expect(page()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('renders the list and passes a failed live snapshot as null, not zero counts', async () => {
    answer({ snapshot: async () => apiFailure(500) });

    render(await page());

    const view = screen.getByTestId('executions-list-view');
    expect(view).toHaveAttribute('data-running', 'failed');
    expect(view).toHaveAttribute('data-executions', 'exec-1,exec-2');
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws and logs when a read rejects', async () => {
    const err = new Error('network');
    vi.mocked(serverFetch).mockRejectedValue(err);

    await expect(page()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), err, expect.any(Object));
  });

  it('renders a real empty list as an empty list', async () => {
    answer({ list: async () => apiSuccess([], { ...META, total: 0 }) });

    render(await page());

    const view = screen.getByTestId('executions-list-view');
    expect(view).toHaveAttribute('data-executions', '');
    expect(view).toHaveAttribute('data-total', '0');
  });
});

describe('ExecutionsListPage — an org admin’s half (§111 t-812)', () => {
  beforeEach(() => {
    viewer.tier = 'org';
  });

  it('reads the executions alone, never the live-engine snapshot', async () => {
    answer();

    render(await page());

    expect(fetched()).toHaveLength(1);
    expect(fetched()[0]).toContain(API.ADMIN.ORCHESTRATION.EXECUTIONS);
    const view = screen.getByTestId('executions-list-view');
    expect(view).toHaveAttribute('data-executions', 'exec-1,exec-2');
    expect(view).toHaveAttribute('data-running', '0');
    expect(view).toHaveAttribute('data-viewer-tier', 'org');
    expect(screen.getByText('Past execution runs.')).toBeInTheDocument();
  });
});
