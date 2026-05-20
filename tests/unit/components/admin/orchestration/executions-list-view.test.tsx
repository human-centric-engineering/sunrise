/**
 * Tests for `ExecutionsListView` — the client shell that composes
 * the live-engine dashboard and the executions table on a single
 * page. The new card-click → URL-update wiring is the main thing
 * this test covers; the dashboard's own behaviour and the table's
 * own behaviour are exercised in their respective files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ExecutionsListView } from '@/components/admin/orchestration/executions-list-view';
import type { LiveEngineSnapshotView } from '@/components/admin/orchestration/live-engine-dashboard';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem } from '@/types/orchestration';

// `next/navigation` is globally mocked in tests/setup.ts to return
// no-op router + empty search params. We retrieve the mock to assert
// `router.replace` was called with the right URL by the card click.
import { useRouter, useSearchParams } from 'next/navigation';

const SNAPSHOT: LiveEngineSnapshotView = {
  running: { count: 3, p95AgeMs: 90_000, maxAgeMs: 180_000 },
  queued: { count: 2, maxWaitMs: 4500 },
  orphaned: { count: 1 },
  providers: [{ provider: 'anthropic', inFlight: 1 }],
  generatedAt: new Date('2026-05-20T12:00:00Z').toISOString(),
};

const META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

function makeExecution(overrides: Partial<ExecutionListItem> = {}): ExecutionListItem {
  return {
    id: 'exec-1',
    workflowId: 'wf-1',
    status: 'completed',
    totalTokensUsed: 100,
    totalCostUsd: 0.001,
    startedAt: '2026-05-20T11:00:00Z',
    createdAt: '2026-05-20T11:00:00Z',
    completedAt: '2026-05-20T11:00:05Z',
    workflow: { id: 'wf-1', name: 'Test Workflow' },
    timeInCurrentStepMs: null,
    ...overrides,
  };
}

describe('ExecutionsListView', () => {
  let mockReplace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Make fetch a no-op resolved Response so the embedded table's
    // mount-time setup doesn't blow up — we only care about the
    // card-click → router.replace wiring here.
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: [], meta: META }))
      ) as typeof fetch;
    mockReplace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: mockReplace,
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
    );
  });

  it('renders the dashboard cards and the table together', () => {
    render(
      <ExecutionsListView
        initialSnapshot={SNAPSHOT}
        initialExecutions={[makeExecution()]}
        initialMeta={META}
        stuckThresholdMins={5}
      />
    );

    // The dashboard's four card titles are visible.
    expect(screen.getByText(/^Running$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Pending$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Orphaned$/i)).toBeInTheDocument();
    expect(screen.getByText(/Provider in-flight/i)).toBeInTheDocument();
    // The table renders its column headers.
    expect(screen.getByText(/Execution ID/i)).toBeInTheDocument();
  });

  it('clicking the Running card pushes ?status=running via router.replace (no navigation)', async () => {
    render(
      <ExecutionsListView
        initialSnapshot={SNAPSHOT}
        initialExecutions={[]}
        initialMeta={META}
        stuckThresholdMins={5}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /running/i }));

    // Card click goes through router.replace (no scroll, no nav), NOT
    // a router.push or window.location change.
    expect(mockReplace).toHaveBeenCalledWith('?status=running', { scroll: false });
  });

  it('clicking the Pending card pushes ?status=pending', async () => {
    render(
      <ExecutionsListView
        initialSnapshot={SNAPSHOT}
        initialExecutions={[]}
        initialMeta={META}
        stuckThresholdMins={5}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /pending/i }));

    expect(mockReplace).toHaveBeenCalledWith('?status=pending', { scroll: false });
  });

  it('clicking the Orphaned card pushes ?status=running (subset of running)', async () => {
    render(
      <ExecutionsListView
        initialSnapshot={SNAPSHOT}
        initialExecutions={[]}
        initialMeta={META}
        stuckThresholdMins={5}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /orphaned/i }));

    // Orphaned is a strict subset of Running — there is no `?status=orphaned`
    // server-side filter (the executions-list endpoint doesn't have one),
    // so we filter into Running and let the operator sort by step age.
    expect(mockReplace).toHaveBeenCalledWith('?status=running', { scroll: false });
  });

  it('preserves existing query params when applying the status filter', async () => {
    // Simulate the user arriving with a workflowId already pinned in the URL.
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('workflowId=wf-abc') as unknown as ReturnType<typeof useSearchParams>
    );
    render(
      <ExecutionsListView
        initialSnapshot={SNAPSHOT}
        initialExecutions={[]}
        initialMeta={META}
        stuckThresholdMins={5}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /running/i }));

    // The workflowId pin must survive — clicking a card should not
    // clear unrelated filters the operator put in place.
    expect(mockReplace).toHaveBeenCalledWith('?workflowId=wf-abc&status=running', {
      scroll: false,
    });
  });
});
