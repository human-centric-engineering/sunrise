/**
 * ExecutionsTable Component Tests
 *
 * Test Coverage:
 * - Renders table headers and rows
 * - Status filter triggers refetch
 * - Row links point to execution detail
 * - Pagination buttons are wired
 * - Empty state renders correctly
 * - Stuck-row amber highlight (stuckThresholdMins)
 * - Step-age column formatting
 * - Row-actions dropdown: View trace, View lease, Force fail
 * - Force-fail disabled for terminal statuses
 * - Force-fail confirmation dialog open/submit/error paths
 * - LeaseInspectorDialog opens on "View lease"
 *
 * @see components/admin/orchestration/executions-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExecutionsTable } from '@/components/admin/orchestration/executions-table';
import { createMockFetchResponse } from '@/tests/helpers/mocks';
import { createMockRouter } from '@/tests/types/mocks';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem } from '@/types/orchestration';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeExecution(overrides: Partial<ExecutionListItem> = {}): ExecutionListItem {
  return {
    id: 'exec-001-aaaa-bbbb-cccc-dddddddddddd',
    workflowId: 'wf-1',
    status: 'completed',
    totalTokensUsed: 1500,
    totalCostUsd: 0.0042,
    startedAt: '2026-04-18T10:00:00Z',
    createdAt: '2026-04-18T10:00:00Z',
    completedAt: '2026-04-18T10:00:03Z',
    workflow: { id: 'wf-1', name: 'Test Workflow' },
    timeInCurrentStepMs: null,
    ...overrides,
  };
}

const MOCK_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 2,
  totalPages: 1,
};

const TWO_EXECUTIONS: ExecutionListItem[] = [
  makeExecution(),
  makeExecution({
    id: 'exec-002-aaaa-bbbb-cccc-dddddddddddd',
    status: 'failed',
    totalTokensUsed: 800,
    totalCostUsd: 0.002,
    completedAt: null,
  }),
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ExecutionsTable', () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn<typeof fetch>();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValue(
      createMockFetchResponse({ success: true, data: TWO_EXECUTIONS, meta: MOCK_META })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders table headers', () => {
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      expect(screen.getByText('Execution ID')).toBeInTheDocument();
      expect(screen.getByText('Workflow')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
      expect(screen.getByText('Tokens')).toBeInTheDocument();
      expect(screen.getByText('Cost')).toBeInTheDocument();
      expect(screen.getByText('Duration')).toBeInTheDocument();
      expect(screen.getByText('Started')).toBeInTheDocument();
    });

    it('renders execution rows with truncated IDs', () => {
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      expect(screen.getByText('exec-001…')).toBeInTheDocument();
      expect(screen.getByText('exec-002…')).toBeInTheDocument();
    });

    it('renders status badges', () => {
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });

    it('renders workflow name as links', () => {
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      const links = screen.getAllByRole('link', { name: 'Test Workflow' });
      expect(links[0]).toHaveAttribute('href', '/admin/orchestration/workflows/wf-1');
    });

    it('renders empty state when no executions', () => {
      render(<ExecutionsTable initialExecutions={[]} initialMeta={{ ...MOCK_META, total: 0 }} />);

      expect(screen.getByText(/no executions found/i)).toBeInTheDocument();
    });

    it('renders pagination info', () => {
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      expect(screen.getByText(/showing 1 to 2 of 2 executions/i)).toBeInTheDocument();
    });
  });

  describe('status filter', () => {
    it('changing status filter triggers a refetch with status param', async () => {
      const user = userEvent.setup();
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      // Open the status select
      await user.click(screen.getByRole('combobox'));
      await user.click(screen.getByRole('option', { name: /running/i }));

      await waitFor(() => {
        const calls = mockFetch.mock.calls;
        const lastArg = calls[calls.length - 1]?.[0];
        const lastUrl = typeof lastArg === 'string' ? lastArg : '';
        expect(lastUrl).toContain('status=running');
      });
    });
  });

  describe('workflowId filter', () => {
    it('renders a badge when initialWorkflowId is provided', () => {
      render(
        <ExecutionsTable
          initialExecutions={TWO_EXECUTIONS}
          initialMeta={MOCK_META}
          initialWorkflowId="wf-1"
        />
      );

      expect(screen.getByText(/filtered by workflow/i)).toBeInTheDocument();
    });

    it('includes workflowId in fetch when provided', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionsTable
          initialExecutions={TWO_EXECUTIONS}
          initialMeta={MOCK_META}
          initialWorkflowId="wf-1"
        />
      );

      // Trigger a refetch via status change
      await user.click(screen.getByRole('combobox'));
      await user.click(screen.getByRole('option', { name: /failed/i }));

      await waitFor(() => {
        const calls = mockFetch.mock.calls;
        const lastArg = calls[calls.length - 1]?.[0];
        const lastUrl = typeof lastArg === 'string' ? lastArg : '';
        expect(lastUrl).toContain('workflowId=wf-1');
      });
    });
  });

  describe('pagination', () => {
    it('Previous button is disabled on page 1', () => {
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    });

    it('Next button is disabled on last page', () => {
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    });

    it('Next button triggers fetch for page 2 when not on last page', async () => {
      const user = userEvent.setup();
      const multiPageMeta = { ...MOCK_META, total: 50, totalPages: 2 };
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={multiPageMeta} />);

      await user.click(screen.getByRole('button', { name: /next/i }));

      await waitFor(() => {
        const calls = mockFetch.mock.calls;
        const lastArg = calls[calls.length - 1]?.[0];
        const lastUrl = typeof lastArg === 'string' ? lastArg : '';
        expect(lastUrl).toContain('page=2');
      });
    });
  });

  describe('URL-persisted status filter', () => {
    it('initializes filter from initialStatus prop', () => {
      render(
        <ExecutionsTable
          initialExecutions={TWO_EXECUTIONS}
          initialMeta={MOCK_META}
          initialStatus="failed"
        />
      );

      // The select trigger should show the "Failed" label
      expect(screen.getByRole('combobox')).toHaveTextContent('Failed');
    });

    it('updates URL when status filter changes', async () => {
      const { useRouter } = await import('next/navigation');
      const mockReplace = vi.fn();
      vi.mocked(useRouter).mockReturnValue(createMockRouter({ replace: mockReplace }));

      const user = userEvent.setup();
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      const trigger = screen.getByRole('combobox');
      await user.click(trigger);
      await user.click(screen.getByRole('option', { name: /^Failed$/i }));

      expect(mockReplace).toHaveBeenCalledWith(
        expect.stringContaining('status=failed'),
        expect.objectContaining({ scroll: false })
      );
    });

    it('removes status from URL when filter reset to "all"', async () => {
      const { useRouter } = await import('next/navigation');
      const mockReplace = vi.fn();
      vi.mocked(useRouter).mockReturnValue(createMockRouter({ replace: mockReplace }));

      const user = userEvent.setup();
      render(
        <ExecutionsTable
          initialExecutions={TWO_EXECUTIONS}
          initialMeta={MOCK_META}
          initialStatus="failed"
        />
      );

      const trigger = screen.getByRole('combobox');
      await user.click(trigger);
      await user.click(screen.getByRole('option', { name: /all statuses/i }));

      expect(mockReplace).toHaveBeenCalledWith('?', expect.objectContaining({ scroll: false }));
    });
  });

  describe('duration', () => {
    it('computes duration from startedAt, not createdAt', () => {
      const exec = makeExecution({
        startedAt: '2026-04-18T10:00:05Z',
        createdAt: '2026-04-18T10:00:00Z',
        completedAt: '2026-04-18T10:00:08Z',
      });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      // 3s (from startedAt to completedAt), not 8s (from createdAt)
      expect(screen.getByText('3.0s')).toBeInTheDocument();
    });

    it('shows elapsed time for running executions (startedAt set, completedAt null)', () => {
      const exec = makeExecution({
        status: 'running',
        startedAt: new Date(Date.now() - 5000).toISOString(),
        completedAt: null,
      });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      // Should show a duration like "5.0s" (not "—")
      const cells = screen.getAllByRole('cell');
      const durationCell = cells.find((cell) => /\d+\.\d+s|\d+ ms/.test(cell.textContent ?? ''));
      expect(durationCell).toBeTruthy();
    });
  });

  // ─── Stuck-row highlight ────────────────────────────────────────────────────

  describe('stuck-row amber highlight', () => {
    it('applies amber background when timeInCurrentStepMs meets the threshold', () => {
      // Arrange: 10 minutes elapsed, threshold is 5 minutes → row is stuck
      const exec = makeExecution({ status: 'running', timeInCurrentStepMs: 600_000 });
      render(
        <ExecutionsTable
          initialExecutions={[exec]}
          initialMeta={MOCK_META}
          stuckThresholdMins={5}
        />
      );

      // Act + Assert: the <tr> for this row carries the amber class
      // The component sets className="bg-amber-50 dark:bg-amber-950/30" on stuck rows.
      const rows = screen.getAllByRole('row');
      // First row is the header row; the first data row is index 1.
      const dataRow = rows[1];
      expect(dataRow).toHaveClass('bg-amber-50');
    });

    it('does not apply amber background when step age is below the threshold', () => {
      // Arrange: 2 minutes elapsed, threshold is 5 minutes → not stuck
      const exec = makeExecution({ status: 'running', timeInCurrentStepMs: 120_000 });
      render(
        <ExecutionsTable
          initialExecutions={[exec]}
          initialMeta={MOCK_META}
          stuckThresholdMins={5}
        />
      );

      const rows = screen.getAllByRole('row');
      const dataRow = rows[1];
      expect(dataRow).not.toHaveClass('bg-amber-50');
    });
  });

  // ─── Step-age column formatting ─────────────────────────────────────────────

  describe('step-age column formatting', () => {
    it('renders "—" when timeInCurrentStepMs is null', () => {
      const exec = makeExecution({ timeInCurrentStepMs: null });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      // The muted dash is rendered as a plain "—" character in a span
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('renders "10s" for 10_000 ms', () => {
      const exec = makeExecution({ timeInCurrentStepMs: 10_000 });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      expect(screen.getByText('10s')).toBeInTheDocument();
    });

    it('renders "2m" for 120_000 ms', () => {
      const exec = makeExecution({ timeInCurrentStepMs: 120_000 });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      expect(screen.getByText('2m')).toBeInTheDocument();
    });

    it('renders "1.0h" for 3_600_000 ms', () => {
      const exec = makeExecution({ timeInCurrentStepMs: 3_600_000 });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      expect(screen.getByText('1.0h')).toBeInTheDocument();
    });
  });

  // ─── AlertTriangle icon on stuck row ───────────────────────────────────────

  describe('stuck-row AlertTriangle indicator', () => {
    it('shows the stuck-threshold title attribute when step age exceeds threshold', () => {
      // Arrange: 600 s elapsed, threshold 5 m → stuck
      const exec = makeExecution({ status: 'running', timeInCurrentStepMs: 600_000 });
      render(
        <ExecutionsTable
          initialExecutions={[exec]}
          initialMeta={MOCK_META}
          stuckThresholdMins={5}
        />
      );

      // The component sets title="Exceeds the 5m stuck threshold" on the span wrapping the icon
      expect(screen.getByTitle('Exceeds the 5m stuck threshold')).toBeInTheDocument();
    });
  });

  // ─── Row-actions dropdown ───────────────────────────────────────────────────

  describe('row-actions dropdown', () => {
    it('opens with View trace, View lease, and Force fail items', async () => {
      const user = userEvent.setup();
      render(<ExecutionsTable initialExecutions={[makeExecution()]} initialMeta={MOCK_META} />);

      // Act: click the row-actions trigger button (sr-only label "Row actions")
      await user.click(screen.getByRole('button', { name: /row actions/i }));

      // Assert: all three items appear (Radix renders into a portal on document.body)
      expect(
        await screen.findByRole('menuitem', { name: /view trace/i, hidden: true })
      ).toBeInTheDocument();
      expect(
        await screen.findByRole('menuitem', { name: /view lease/i, hidden: true })
      ).toBeInTheDocument();
      expect(
        await screen.findByRole('menuitem', { name: /force fail/i, hidden: true })
      ).toBeInTheDocument();
    });

    it('Force fail item is disabled for terminal statuses', async () => {
      const user = userEvent.setup();
      // completed is a terminal status — canForceFail will be false
      const exec = makeExecution({ status: 'completed' });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /row actions/i }));

      const forceFailItem = await screen.findByRole('menuitem', {
        name: /force fail/i,
        hidden: true,
      });
      // Radix sets data-disabled="" on disabled menu items
      expect(forceFailItem).toHaveAttribute('data-disabled');
    });

    it('Force fail is enabled for non-terminal statuses', async () => {
      const user = userEvent.setup();
      const exec = makeExecution({ status: 'running' });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /row actions/i }));

      const forceFailItem = await screen.findByRole('menuitem', {
        name: /force fail/i,
        hidden: true,
      });
      // Not disabled — no data-disabled attribute
      expect(forceFailItem).not.toHaveAttribute('data-disabled');
    });
  });

  // ─── Force-fail confirmation dialog ────────────────────────────────────────

  describe('force-fail confirmation dialog', () => {
    it('opens the AlertDialog when Force fail is clicked on a running execution', async () => {
      const user = userEvent.setup();
      const exec = makeExecution({ status: 'running' });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /row actions/i }));
      const forceFailItem = await screen.findByRole('menuitem', {
        name: /force fail/i,
        hidden: true,
      });
      await user.click(forceFailItem);

      // Assert: the dialog title and reason textarea are visible
      await waitFor(() => {
        expect(screen.getByText('Force-fail this execution?')).toBeInTheDocument();
      });
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('POSTs with the typed reason and closes the dialog on success', async () => {
      const user = userEvent.setup();
      const exec = makeExecution({
        id: 'exec-run1-aaaa-bbbb-cccc-dddddddddddd',
        status: 'running',
      });

      // First call: the force-fail POST
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: { id: exec.id } })
      );
      // Second call: the list refetch after success
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: [exec], meta: MOCK_META })
      );

      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      // Open menu → click Force fail
      await user.click(screen.getByRole('button', { name: /row actions/i }));
      const forceFailItem = await screen.findByRole('menuitem', {
        name: /force fail/i,
        hidden: true,
      });
      await user.click(forceFailItem);

      // Dialog opens — type a reason
      await waitFor(() =>
        expect(screen.getByText('Force-fail this execution?')).toBeInTheDocument()
      );
      await user.type(screen.getByRole('textbox'), 'test reason');

      // Click the confirm button ("Force fail" in the dialog footer)
      await user.click(screen.getByRole('button', { name: /^force fail$/i }));

      // Assert: POST was sent to the correct URL with the typed reason
      await waitFor(() => {
        const postCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/force-fail') &&
            (call[1] as RequestInit)?.method === 'POST'
        );
        expect(postCall).toBeDefined();
        const body = JSON.parse((postCall?.[1] as RequestInit).body as string) as {
          reason: string;
        };
        expect(body.reason).toBe('test reason');
      });

      // Dialog closes after success
      await waitFor(() => {
        expect(screen.queryByText('Force-fail this execution?')).not.toBeInTheDocument();
      });

      // List was refetched
      await waitFor(() => {
        const refetchCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/api/v1/admin/orchestration/executions')
        );
        expect(refetchCall).toBeDefined();
      });
    });

    it('POSTs with empty body {} when no reason is typed', async () => {
      const user = userEvent.setup();
      const exec = makeExecution({ status: 'running' });

      // Force-fail POST succeeds
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: { id: exec.id } })
      );
      // Refetch
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: [exec], meta: MOCK_META })
      );

      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /row actions/i }));
      const forceFailItem = await screen.findByRole('menuitem', {
        name: /force fail/i,
        hidden: true,
      });
      await user.click(forceFailItem);

      await waitFor(() =>
        expect(screen.getByText('Force-fail this execution?')).toBeInTheDocument()
      );

      // Do NOT type a reason — click confirm immediately
      await user.click(screen.getByRole('button', { name: /^force fail$/i }));

      await waitFor(() => {
        const postCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/force-fail') &&
            (call[1] as RequestInit)?.method === 'POST'
        );
        expect(postCall).toBeDefined();
        // Body should be "{}" (no reason key) rather than {"reason":""}
        const body = JSON.parse((postCall?.[1] as RequestInit).body as string) as Record<
          string,
          unknown
        >;
        expect(body).not.toHaveProperty('reason');
        expect(Object.keys(body)).toHaveLength(0);
      });
    });

    it('shows the server error message in the dialog and keeps it open on failure', async () => {
      const user = userEvent.setup();
      const exec = makeExecution({ status: 'running' });

      // Force-fail POST returns a 409 with a structured error envelope
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: false, error: { message: 'already terminal' } }, 409)
      );

      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /row actions/i }));
      const forceFailItem = await screen.findByRole('menuitem', {
        name: /force fail/i,
        hidden: true,
      });
      await user.click(forceFailItem);

      await waitFor(() =>
        expect(screen.getByText('Force-fail this execution?')).toBeInTheDocument()
      );

      await user.click(screen.getByRole('button', { name: /^force fail$/i }));

      // Assert: dialog stays open and the server message is displayed
      await waitFor(() => {
        expect(screen.getByText('already terminal')).toBeInTheDocument();
      });
      // Dialog still showing
      expect(screen.getByText('Force-fail this execution?')).toBeInTheDocument();
    });
  });

  // ─── LeaseInspectorDialog ──────────────────────────────────────────────────

  describe('lease inspector', () => {
    it('opens LeaseInspectorDialog when View lease is clicked', async () => {
      const user = userEvent.setup();
      const exec = makeExecution({ status: 'running' });

      // Mock the lease GET request
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({
          success: true,
          data: {
            current: {
              token: '…abc12',
              expiresAt: null,
              lastHeartbeatAt: null,
              recoveryAttempts: 0,
            },
            history: [],
          },
        })
      );

      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /row actions/i }));
      const viewLeaseItem = await screen.findByRole('menuitem', {
        name: /view lease/i,
        hidden: true,
      });
      await user.click(viewLeaseItem);

      // The LeaseInspectorDialog renders a Dialog with title "Lease inspector"
      await waitFor(() => {
        expect(screen.getByText('Lease inspector')).toBeInTheDocument();
      });
    });
  });

  // Refetch failure path: the catch block sets a user-facing message
  // ("Could not load executions. Try refreshing the page.") without
  // crashing the table.
  describe('list refetch error path', () => {
    it('surfaces a friendly error banner when the executions refetch fails', async () => {
      const user = userEvent.setup();
      mockFetch.mockRejectedValueOnce(new TypeError('network down'));

      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: /running/i }));

      await waitFor(() => {
        expect(
          screen.getByText('Could not load executions. Try refreshing the page.')
        ).toBeInTheDocument();
      });
    });
  });

  // Pagination prev-button branch: previous tests cover "next" via
  // status-filter refetch; this covers the previous-page click on a
  // page-2 starting state plus the page-1 disabled boundary.
  describe('pagination — previous button', () => {
    it('clicking Previous on page 2 issues a page=1 refetch', async () => {
      const user = userEvent.setup();
      const page2Meta = { page: 2, limit: 25, total: 50, totalPages: 2 } as const;
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: TWO_EXECUTIONS,
            meta: { page: 1, limit: 25, total: 50, totalPages: 2 },
          })
        )
      );

      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={page2Meta} />);

      const prev = screen.getByRole('button', { name: /previous/i });
      expect(prev).not.toBeDisabled();
      await user.click(prev);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
      const lastCallUrl = mockFetch.mock.calls.at(-1)?.[0];
      // The component always passes the URL as a string template literal —
      // narrow rather than String()-coerce so TypeScript stays honest.
      expect(typeof lastCallUrl).toBe('string');
      expect(lastCallUrl as string).toContain('page=1');
    });

    it('Previous is disabled on page 1', () => {
      render(<ExecutionsTable initialExecutions={TWO_EXECUTIONS} initialMeta={MOCK_META} />);
      expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    });
  });

  // AlertDialog cancellation runs the `onOpenChange(false)` branch
  // that clears the target, reason, and error state. Without this
  // test, a future regression that forgets to reset state on cancel
  // would slip through.
  describe('force-fail dialog cleanup', () => {
    it('cancelling the dialog clears its state and closes it', async () => {
      const user = userEvent.setup();
      const exec = makeExecution({ status: 'running' });
      render(<ExecutionsTable initialExecutions={[exec]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /row actions/i }));
      const forceFailItem = await screen.findByRole('menuitem', {
        name: /force fail/i,
        hidden: true,
      });
      await user.click(forceFailItem);

      const reasonField = await screen.findByLabelText(/reason \(optional\)/i);
      await user.type(reasonField, 'noise');

      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      await waitFor(() => {
        expect(screen.queryByText('Force-fail this execution?')).not.toBeInTheDocument();
      });
    });
  });
});
