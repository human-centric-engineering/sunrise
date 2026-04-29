/**
 * ExecutionsTable Component Tests
 *
 * Test Coverage:
 * - Renders table headers and rows
 * - Status filter triggers refetch
 * - Row links point to execution detail
 * - Pagination buttons are wired
 * - Empty state renders correctly
 *
 * @see components/admin/orchestration/executions-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExecutionsTable } from '@/components/admin/orchestration/executions-table';
import { createMockFetchResponse } from '@/tests/helpers/mocks';
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
    global.fetch = mockFetch as typeof fetch;
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

      expect(screen.getByText('Execution')).toBeInTheDocument();
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
      vi.mocked(useRouter).mockReturnValue({
        replace: mockReplace,
        push: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        refresh: vi.fn(),
        prefetch: vi.fn(),
      } as never);

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
      vi.mocked(useRouter).mockReturnValue({
        replace: mockReplace,
        push: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        refresh: vi.fn(),
        prefetch: vi.fn(),
      } as never);

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
});
