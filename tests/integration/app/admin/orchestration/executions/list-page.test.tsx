// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Executions list page
 *
 * Tests the server-component page at `app/admin/orchestration/executions/page.tsx`:
 * its three reads (the executions page, the live-engine snapshot, the
 * stuck-step threshold), its fallbacks when a read fails, and the org
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

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
    initialSnapshot: { running: { count: number } };
    initialExecutions: { id: string }[];
    initialMeta: { total: number };
    initialWorkflowId?: string;
    initialStatus?: string;
    stuckThresholdMins: number;
    viewerTier?: string;
  }) => (
    <div
      data-testid="executions-list-view"
      data-running={props.initialSnapshot.running.count}
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
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

const SNAPSHOT = {
  running: { count: 3, p95AgeMs: 100, maxAgeMs: 200 },
  queued: { count: 1, maxWaitMs: 50 },
  orphaned: { count: 0 },
  providers: [],
  generatedAt: '2026-10-15T12:00:00.000Z',
};
const META = { page: 1, limit: 25, total: 2, totalPages: 1 };

function answer(): void {
  vi.mocked(serverFetch).mockImplementation(
    async (url: string) => ({ ok: true, _url: url }) as unknown as Response
  );
  vi.mocked(parseApiResponse).mockImplementation((async (res: { _url: string }) =>
    res._url.startsWith(API.ADMIN.ORCHESTRATION.EXECUTIONS_LIVE_SNAPSHOT)
      ? { success: true, data: SNAPSHOT }
      : { success: true, data: [{ id: 'exec-1' }, { id: 'exec-2' }], meta: META }) as never);
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

    render(await page({ workflowId: 'wf-1', status: 'failed' }));
    expect(fetched()[0]).toBe(
      `${API.ADMIN.ORCHESTRATION.EXECUTIONS}?page=1&limit=25&workflowId=wf-1&status=failed`
    );
    expect(screen.getByTestId('executions-list-view')).toHaveAttribute('data-status', 'failed');

    vi.mocked(serverFetch).mockClear();
    render(await page({ status: 'all' }));
    expect(fetched()[0]).toBe(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?page=1&limit=25`);
  });

  it('falls back to an empty list and snapshot when the reads answer not ok', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    render(await page());

    const view = screen.getByTestId('executions-list-view');
    expect(view).toHaveAttribute('data-executions', '');
    expect(view).toHaveAttribute('data-total', '0');
    expect(view).toHaveAttribute('data-running', '0');
  });

  it('falls back the same when the envelopes say success: false', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: false } as never);

    render(await page());

    expect(screen.getByTestId('executions-list-view')).toHaveAttribute('data-total', '0');
  });

  it('falls back and logs each read when they throw', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('network'));

    render(await page());

    expect(screen.getByTestId('executions-list-view')).toHaveAttribute('data-running', '0');
    expect(logger.error).toHaveBeenCalledWith(
      'executions list page: initial fetch failed',
      expect.any(Error)
    );
    expect(logger.error).toHaveBeenCalledWith(
      'executions list page: snapshot fetch failed',
      expect.any(Error)
    );
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
