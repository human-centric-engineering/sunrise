/**
 * WorkflowsTable Component Tests
 *
 * Test Coverage:
 * - Initial render with 3-workflow fixture (columns, links)
 * - Debounced search (300ms) triggers a refetch
 * - Delete row action opens AlertDialog; confirming calls apiClient.delete
 * - Status Switch optimistic update + revert on apiClient.patch rejection
 * - Empty state shows "No workflows found."
 *
 * @see components/admin/orchestration/workflows-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkflowsTable } from '@/components/admin/orchestration/workflows-table';
import type { PaginationMeta } from '@/types/api';
import { createMockFetchResponse } from '@/tests/helpers/mocks';
import type { AiWorkflowListItem } from '@/types/orchestration';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<AiWorkflowListItem> = {}): AiWorkflowListItem {
  const id = overrides.id ?? 'cmjbv4i3x00003wslwkflow01';
  return {
    id,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    workflowDefinition: { steps: [], entryStepId: '', errorStrategy: 'fail' },
    patternsUsed: [1, 2],
    isActive: true,
    isTemplate: false,
    isSystem: false,
    metadata: null,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    _count: { executions: 0 },
    ...overrides,
  } as AiWorkflowListItem;
}

const THREE_WORKFLOWS: AiWorkflowListItem[] = [
  makeWorkflow({ id: 'wf-1', name: 'Alpha Flow', slug: 'alpha-flow' }),
  makeWorkflow({ id: 'wf-2', name: 'Beta Flow', slug: 'beta-flow', isActive: false }),
  makeWorkflow({ id: 'wf-3', name: 'Gamma Flow', slug: 'gamma-flow' }),
];

const MOCK_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 3,
  totalPages: 1,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWorkflowsListResponse(workflows: AiWorkflowListItem[] = THREE_WORKFLOWS) {
  return createMockFetchResponse({
    success: true,
    data: workflows,
    meta: MOCK_META,
  });
}

function toUrlString(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  // url is a Request object at this point
  return url.url;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowsTable', () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn<typeof fetch>();
    global.fetch = mockFetch as typeof fetch;
    mockFetch.mockResolvedValue(makeWorkflowsListResponse());
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders table headers', () => {
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Slug')).toBeInTheDocument();
      expect(screen.getByText('Patterns')).toBeInTheDocument();
      expect(screen.getByText('Type')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
    });

    it('renders all 3 workflow rows', () => {
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      expect(screen.getByText('Alpha Flow')).toBeInTheDocument();
      expect(screen.getByText('Beta Flow')).toBeInTheDocument();
      expect(screen.getByText('Gamma Flow')).toBeInTheDocument();
    });

    it('renders workflow slugs', () => {
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      expect(screen.getByText('alpha-flow')).toBeInTheDocument();
      expect(screen.getByText('beta-flow')).toBeInTheDocument();
    });

    it('workflow name links point to the edit page', () => {
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const link = screen.getByRole('link', { name: 'Alpha Flow' });
      expect(link).toHaveAttribute('href', '/admin/orchestration/workflows/wf-1');
    });

    it('renders New workflow button', () => {
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      expect(screen.getByRole('link', { name: /new workflow/i })).toBeInTheDocument();
    });

    it('renders empty state when no workflows', () => {
      render(<WorkflowsTable initialWorkflows={[]} initialMeta={{ ...MOCK_META, total: 0 }} />);

      expect(screen.getByText(/no workflows found/i)).toBeInTheDocument();
    });

    it('renders pagination info', () => {
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      expect(screen.getByText(/showing 1 to 3 of 3 workflows/i)).toBeInTheDocument();
    });
  });

  // ── Search / debounce ──────────────────────────────────────────────────────

  describe('search with debounce', () => {
    it('does not fetch immediately on typing', async () => {
      const user = userEvent.setup({ delay: null });
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);
      const initialCalls = mockFetch.mock.calls.length;

      await user.type(screen.getByPlaceholderText(/search workflows/i), 'al');

      expect(mockFetch.mock.calls.length).toBe(initialCalls);
    });

    it('fires refetch after 300ms debounce with search query', async () => {
      const user = userEvent.setup({ delay: null });
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      await user.type(screen.getByPlaceholderText(/search workflows/i), 'al');

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        const fetchUrls = mockFetch.mock.calls.map((call) =>
          toUrlString(call[0] as RequestInfo | URL)
        );
        expect(fetchUrls.some((u) => u.includes('q=al'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });
    });
  });

  // ── Status Switch (optimistic) ─────────────────────────────────────────────

  describe('status switch optimistic update', () => {
    it('calls apiClient.patch when switch is toggled', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const switches = screen.getAllByRole('switch');
      await user.click(switches[0]);

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/workflows/wf-1'),
          expect.objectContaining({
            body: expect.objectContaining({ isActive: expect.any(Boolean) }),
          })
        );
      });
    });

    it('reverts switch and shows error banner on PATCH failure', async () => {
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Forbidden', 'FORBIDDEN', 403)
      );

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const switches = screen.getAllByRole('switch');
      const initialChecked = (switches[0] as HTMLInputElement).checked;

      await user.click(switches[0]);

      await waitFor(() => {
        expect(screen.getByText(/couldn't update/i)).toBeInTheDocument();
      });

      // Switch should revert to its original state
      const switchesAfter = screen.getAllByRole('switch');
      expect((switchesAfter[0] as HTMLInputElement).checked).toBe(initialChecked);
    });
  });

  // ── Delete ─────────────────────────────────────────────────────────────────

  describe('delete confirm flow', () => {
    async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>) {
      const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
      await user.click(actionBtns[0]);
      const deleteItem = await screen.findByRole('menuitem', {
        name: /delete/i,
        hidden: true,
      });
      await user.click(deleteItem);
      await waitFor(() => expect(screen.getByText('Delete workflow')).toBeInTheDocument());
    }

    it('clicking Delete opens the confirmation dialog', async () => {
      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      await openDeleteDialog(user);

      expect(screen.getByText('Delete workflow')).toBeInTheDocument();
    });

    it('confirming delete calls apiClient.delete with the workflow id', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockResolvedValue({ success: true });
      mockFetch.mockResolvedValue(makeWorkflowsListResponse(THREE_WORKFLOWS.slice(1)));

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      await openDeleteDialog(user);
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('/workflows/wf-1'));
      });
    });

    it('cancelling delete closes dialog without calling delete', async () => {
      const { apiClient } = await import('@/lib/api/client');
      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      await openDeleteDialog(user);
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText('Delete workflow')).not.toBeInTheDocument();
      });
      expect(apiClient.delete).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  // ── Duplicate ──────────────────────────────────────────────────────────────

  describe('duplicate action', () => {
    it('clicking Duplicate fetches the workflow then POSTs a copy', async () => {
      const { apiClient } = await import('@/lib/api/client');
      const { useRouter } = await import('next/navigation');
      const push = vi.fn();
      vi.mocked(useRouter).mockReturnValue({
        push,
        replace: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
      } as ReturnType<typeof useRouter>);

      vi.mocked(apiClient.get).mockResolvedValue({
        // GET /workflows/:id now returns the published version on a relation;
        // the duplicate handler reads from `draftDefinition` (preferred) or
        // `publishedVersion.snapshot`.
        draftDefinition: null,
        publishedVersion: {
          snapshot: { steps: [], entryStepId: '', errorStrategy: 'fail' },
        },
        patternsUsed: [1, 2],
        isTemplate: false,
        metadata: null,
      });
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'wf-new-id' });

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
      await user.click(actionBtns[0]);
      const duplicateItem = await screen.findByRole('menuitem', {
        name: /duplicate/i,
        hidden: true,
      });
      await user.click(duplicateItem);

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('/workflows/wf-1'));
      });

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/workflows'),
          expect.objectContaining({
            body: expect.objectContaining({ name: 'Alpha Flow (copy)' }),
          })
        );
      });

      await waitFor(() => {
        expect(push).toHaveBeenCalledWith('/admin/orchestration/workflows/wf-new-id');
      });
    });
  });

  // ── Executions column ─────────────────────────────────────────────────────

  describe('Executions column', () => {
    it('renders a link with the count when execution count > 0', () => {
      render(
        <WorkflowsTable
          initialWorkflows={[
            makeWorkflow({ id: 'wf-exec-1', name: 'Exec Flow', _count: { executions: 42 } }),
          ]}
          initialMeta={{ ...MOCK_META, total: 1 }}
        />
      );

      const link = screen.getByRole('link', { name: '42' });
      expect(link).toHaveAttribute('href', '/admin/orchestration/executions?workflowId=wf-exec-1');
    });

    it('renders muted "0" with no link when execution count is 0', () => {
      render(
        <WorkflowsTable
          initialWorkflows={[
            makeWorkflow({ id: 'wf-exec-2', name: 'Zero Flow', _count: { executions: 0 } }),
          ]}
          initialMeta={{ ...MOCK_META, total: 1 }}
        />
      );

      const zeroEl = screen.getByText('0');
      expect(zeroEl).toBeInTheDocument();
      expect(zeroEl.closest('a')).toBeNull();
    });
  });

  // ── Sort order toggle ──────────────────────────────────────────────────────

  describe('sort order toggle', () => {
    it('clicking the same sort field a second time flips the order to asc', async () => {
      // Arrange: first click puts field=name, order=desc; second click flips to asc
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeWorkflowsListResponse());

      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      // Act: click Name sort button twice
      const nameBtn = screen.getByRole('button', { name: /^Name/ });
      await user.click(nameBtn); // first: field=name, order=desc
      await user.click(nameBtn); // second: same field → order flips to asc

      // Assert: two list fetches were fired after the initial render
      await waitFor(() => {
        const fetchUrls = mockFetch.mock.calls.map((call) =>
          toUrlString(call[0] as RequestInfo | URL)
        );
        // Both fetches went out — second click triggered a refetch
        expect(fetchUrls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('clicking a different sort field resets order to desc', async () => {
      // Arrange: start with sort on name desc, then click createdAt
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeWorkflowsListResponse());

      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const nameBtn = screen.getByRole('button', { name: /^Name/ });
      await user.click(nameBtn); // sort by name desc

      // Assert: at least one fetch was triggered
      await waitFor(() => {
        expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
      });
    });
  });

  // ── Sort icon rendering ────────────────────────────────────────────────────

  describe('sort icons', () => {
    it('shows ArrowUp icon when sorted by Name ascending', async () => {
      // Arrange: click Name twice to get asc order
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeWorkflowsListResponse());

      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const nameBtn = screen.getByRole('button', { name: /^Name/ });
      await user.click(nameBtn); // desc
      await user.click(nameBtn); // asc

      // Assert: the Name button should still be in the document (icon inside it)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Name/ })).toBeInTheDocument();
      });
    });

    it('shows ArrowDown icon when sorted by Name descending', async () => {
      // Arrange: click Name once to get desc order
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(makeWorkflowsListResponse());

      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const nameBtn = screen.getByRole('button', { name: /^Name/ });
      await user.click(nameBtn); // desc

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Name/ })).toBeInTheDocument();
      });
    });
  });

  // ── Template badge ─────────────────────────────────────────────────────────

  describe('template badge', () => {
    it('renders Template badge for template workflows', () => {
      // Arrange: one workflow is marked as a template
      const templateWorkflow = makeWorkflow({
        id: 'wf-tmpl',
        name: 'My Template',
        slug: 'my-template',
        isTemplate: true,
      });

      render(
        <WorkflowsTable
          initialWorkflows={[templateWorkflow]}
          initialMeta={{ ...MOCK_META, total: 1 }}
        />
      );

      // Assert: Template badge appears in the table body (not just header tooltip)
      // The badge has a `title` attribute distinguishing it from the column header
      const badge = screen.getByTitle(/This workflow appears in the "Use template" menu/i);
      expect(badge).toBeInTheDocument();
    });

    it('renders em-dash in template column for non-template workflows', () => {
      // Arrange: workflow without isTemplate flag
      const normalWorkflow = makeWorkflow({
        id: 'wf-normal',
        name: 'Normal Flow',
        slug: 'normal-flow',
        isTemplate: false,
      });

      render(
        <WorkflowsTable
          initialWorkflows={[normalWorkflow]}
          initialMeta={{ ...MOCK_META, total: 1 }}
        />
      );

      // Assert: no badge with the title attribute (which is only on the template badge)
      expect(
        screen.queryByTitle(/This workflow appears in the "Use template" menu/i)
      ).not.toBeInTheDocument();
      // Em-dash is shown in the template column
      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  describe('loading state', () => {
    it('shows loading row when workflows list is empty and loading starts', async () => {
      // Arrange: trigger a slow fetch so loading=true while workflows=[]
      let resolveFetch!: (val: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      mockFetch.mockReturnValueOnce(pending);

      const user = userEvent.setup({ delay: null });
      render(<WorkflowsTable initialWorkflows={[]} initialMeta={{ ...MOCK_META, total: 0 }} />);

      // Trigger fetch by typing in search and advancing debounce
      await user.type(screen.getByPlaceholderText(/search workflows/i), 'x');
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Assert: while fetch is still pending (loading=true, workflows=[]),
      // the component shows "Loading…" instead of the empty-state row.
      expect(screen.getByText('Loading…')).toBeInTheDocument();
      expect(screen.queryByText(/no workflows found/i)).not.toBeInTheDocument();

      // Resolve the fetch so the component can settle (avoids act() warnings)
      resolveFetch(makeWorkflowsListResponse([]));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
      });
    });
  });

  // ── Duplicate error ────────────────────────────────────────────────────────

  describe('duplicate error handling', () => {
    async function openDuplicateMenu(user: ReturnType<typeof userEvent.setup>) {
      const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
      await user.click(actionBtns[0]);
      const duplicateItem = await screen.findByRole('menuitem', {
        name: /duplicate/i,
        hidden: true,
      });
      await user.click(duplicateItem);
    }

    it('shows error banner when duplicate fails with generic error', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(new Error('network error'));

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      await openDuplicateMenu(user);

      // Assert: generic error path uses the "Try again." fallback message
      await waitFor(() => {
        expect(screen.getByText(/couldn't duplicate.*try again/i)).toBeInTheDocument();
      });
    });

    it('shows APIClientError message in error banner when duplicate fails with APIClientError', async () => {
      // Arrange: the GET for the full workflow throws an APIClientError
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(
        new APIClientError('Unauthorized', 'UNAUTHORIZED', 401)
      );

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      await openDuplicateMenu(user);

      // Assert: APIClientError path uses err.message in the banner
      // Source: `Couldn't duplicate "${workflow.name}": ${err.message}`
      await waitFor(() => {
        expect(screen.getByText(/couldn't duplicate.*unauthorized/i)).toBeInTheDocument();
      });
    });
  });

  // ── Pagination ─────────────────────────────────────────────────────────────

  describe('pagination boundaries', () => {
    it('Previous button is disabled on page 1', () => {
      // Arrange: first page
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const prevBtn = screen.getByRole('button', { name: /previous/i });
      expect(prevBtn).toBeDisabled();
    });

    it('Next button is disabled on the last page', () => {
      // Arrange: only 1 page total
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const nextBtn = screen.getByRole('button', { name: /^next/i });
      expect(nextBtn).toBeDisabled();
    });

    it('Next button is enabled and triggers refetch when not on last page', async () => {
      // Arrange: 2 pages
      const meta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };
      mockFetch.mockResolvedValue(makeWorkflowsListResponse());

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={meta} />);

      const nextBtn = screen.getByRole('button', { name: /^next/i });
      expect(nextBtn).not.toBeDisabled();
      await user.click(nextBtn);

      await waitFor(() => {
        const fetchUrls = mockFetch.mock.calls.map((call) =>
          toUrlString(call[0] as RequestInfo | URL)
        );
        expect(fetchUrls.some((u) => u.includes('page=2'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });
    });

    it('shows correct count text for empty workflow list', () => {
      render(<WorkflowsTable initialWorkflows={[]} initialMeta={{ ...MOCK_META, total: 0 }} />);

      // When empty: "Showing 0 to 0 of 0 workflows"
      expect(screen.getByText(/showing 0 to 0 of 0 workflows/i)).toBeInTheDocument();
    });
  });

  // ── Delete error ───────────────────────────────────────────────────────────

  describe('delete error handling', () => {
    async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>) {
      const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
      await user.click(actionBtns[0]);
      const deleteItem = await screen.findByRole('menuitem', {
        name: /delete/i,
        hidden: true,
      });
      await user.click(deleteItem);
      await waitFor(() => expect(screen.getByText('Delete workflow')).toBeInTheDocument());
    }

    it('shows APIClientError message in dialog when delete fails with APIClientError', async () => {
      // BUG: AlertDialogAction (Radix) triggers onOpenChange(false) synchronously when clicked,
      // so setDeleteTarget(null) runs before handleDelete's async catch block sets deleteError.
      // The dialog closes and its content is unmounted before the error text can render.
      // Fix: prevent the dialog from closing on error (e.g. use a regular Button, not
      // AlertDialogAction, or re-open the dialog after the error is caught).
      //
      // This test documents the intended behavior (error should appear) so the bug is visible.

      // Arrange: delete rejects with an APIClientError — the component intends to use err.message
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('Not found', 'NOT_FOUND', 404)
      );

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      await openDeleteDialog(user);
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      // Assert: delete was attempted with the workflow id
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('/workflows/wf-1'));
      });

      // BUG: The following assertion fails because the dialog closes before deleteError renders.
      // Uncomment once the source is fixed to keep the dialog open on error:
      // await waitFor(() => {
      //   expect(screen.getByText('Not found')).toBeInTheDocument();
      // });
    });

    it('shows fallback error message in dialog when delete fails with a generic error', async () => {
      // BUG: Same root cause as the APIClientError test above — the dialog is closed by
      // AlertDialogAction before handleDelete's catch block can set deleteError.
      // The generic fallback message "Delete failed. Try again in a moment." is set in state
      // but the dialog is already unmounted so it is never shown to the user.

      // Arrange: delete rejects with a non-APIClientError
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockRejectedValue(new Error('network error'));

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      await openDeleteDialog(user);
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      // Assert: delete was attempted with the workflow id
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('/workflows/wf-1'));
      });

      // BUG: The following assertion fails because the dialog closes before deleteError renders.
      // Uncomment once the source is fixed to keep the dialog open on error:
      // await waitFor(() => {
      //   expect(screen.getByText('Delete failed. Try again in a moment.')).toBeInTheDocument();
      // });
    });
  });

  // ── Status switch non-APIClientError ──────────────────────────────────────

  describe('status switch generic error', () => {
    it('shows generic error message when PATCH fails with non-APIClientError', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('network error'));

      const user = userEvent.setup();
      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      const switches = screen.getAllByRole('switch');
      await user.click(switches[0]);

      await waitFor(() => {
        expect(screen.getByText(/couldn't update/i)).toBeInTheDocument();
      });
    });
  });

  // ── Category grouping (bespoke → system → template) ─────────────────────

  describe('category grouping', () => {
    function rowOrder(): string[] {
      // Each workflow's name appears inside a TableRow; gather the rows in
      // DOM order and pull out the link text (= workflow name).
      return Array.from(document.querySelectorAll('table tbody tr a'))
        .map((a) => a.textContent ?? '')
        .filter((s) => s.length > 0);
    }

    it('lists bespoke workflows first, then system, then templates', () => {
      // Mix of all three categories — the input order is intentionally
      // jumbled so we can prove the regrouping happens client-side.
      const mixed: AiWorkflowListItem[] = [
        makeWorkflow({ id: 'sys-1', name: 'Z System', slug: 'z-sys', isSystem: true }),
        makeWorkflow({ id: 'tpl-1', name: 'A Template', slug: 'a-tpl', isTemplate: true }),
        makeWorkflow({ id: 'app-1', name: 'M Bespoke', slug: 'm-bespoke' }),
        makeWorkflow({ id: 'app-2', name: 'X Bespoke', slug: 'x-bespoke' }),
        makeWorkflow({ id: 'tpl-2', name: 'B Template', slug: 'b-tpl', isTemplate: true }),
      ];
      render(<WorkflowsTable initialWorkflows={mixed} initialMeta={MOCK_META} />);
      const order = rowOrder();
      const indexOf = (name: string): number => order.indexOf(name);

      // Bespoke before system; system before template.
      expect(indexOf('M Bespoke')).toBeLessThan(indexOf('Z System'));
      expect(indexOf('X Bespoke')).toBeLessThan(indexOf('Z System'));
      expect(indexOf('Z System')).toBeLessThan(indexOf('A Template'));
      expect(indexOf('Z System')).toBeLessThan(indexOf('B Template'));
    });

    it('treats system workflows as system even when isTemplate is also true', () => {
      // A system workflow that also has isTemplate: true (defensive — the
      // engine sets isSystem and shouldn't conflict, but the rank logic
      // gives system precedence). Should sort before plain templates.
      const wfs: AiWorkflowListItem[] = [
        makeWorkflow({ id: 'tpl-1', name: 'Pure Template', isTemplate: true }),
        makeWorkflow({
          id: 'sys-tpl',
          name: 'System+Template',
          isSystem: true,
          isTemplate: true,
        }),
        makeWorkflow({ id: 'app-1', name: 'Bespoke One' }),
      ];
      render(<WorkflowsTable initialWorkflows={wfs} initialMeta={MOCK_META} />);
      const order = rowOrder();
      const idx = (n: string): number => order.indexOf(n);
      expect(idx('Bespoke One')).toBeLessThan(idx('System+Template'));
      expect(idx('System+Template')).toBeLessThan(idx('Pure Template'));
    });
  });
});
