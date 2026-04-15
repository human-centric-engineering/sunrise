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
import type { AiWorkflow } from '@prisma/client';

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

function makeWorkflow(overrides: Partial<AiWorkflow> = {}): AiWorkflow {
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
    metadata: null,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  } as AiWorkflow;
}

const THREE_WORKFLOWS: AiWorkflow[] = [
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

function makeWorkflowsListResponse(workflows: AiWorkflow[] = THREE_WORKFLOWS) {
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
      expect(screen.getByText('Template')).toBeInTheDocument();
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
        expect(fetchUrls.some((u) => u.includes('q=al'))).toBe(true);
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
      expect(apiClient.delete).not.toHaveBeenCalled();
    });
  });

  // ── Executions column ─────────────────────────────────────────────────────

  describe('Executions column', () => {
    /**
     * Helper: build a mock fetch that dispatches on URL.
     *   - URLs containing "/executions" return the given executions response.
     *   - All other URLs return the standard workflows list response.
     */
    function makeDispatchedFetch(execResponse: Response) {
      return vi.fn<typeof fetch>((input: RequestInfo | URL) => {
        const url = toUrlString(input);
        if (url.includes('/executions')) {
          return Promise.resolve(execResponse);
        }
        return Promise.resolve(makeWorkflowsListResponse());
      });
    }

    function makeExecCountResponse(total: number) {
      return createMockFetchResponse({
        success: true,
        data: [],
        meta: { page: 1, limit: 1, total, totalPages: Math.ceil(total / 1) },
      });
    }

    it('shows "…" placeholder while execution counts are still loading', async () => {
      // Return a promise that never resolves for executions so the count stays pending.
      const pendingExecFetch = vi.fn<typeof fetch>((input: RequestInfo | URL) => {
        const url = toUrlString(input);
        if (url.includes('/executions')) {
          return new Promise<Response>(() => {
            // intentionally never resolves
          });
        }
        return Promise.resolve(makeWorkflowsListResponse());
      });
      mockFetch = pendingExecFetch;
      global.fetch = mockFetch as typeof fetch;

      render(<WorkflowsTable initialWorkflows={THREE_WORKFLOWS} initialMeta={MOCK_META} />);

      // The "…" placeholder must be present before any exec fetch resolves.
      expect(screen.getAllByText('…').length).toBeGreaterThan(0);
    });

    it('renders a link with the count when execution count > 0', async () => {
      mockFetch = makeDispatchedFetch(makeExecCountResponse(42));
      global.fetch = mockFetch as typeof fetch;

      render(
        <WorkflowsTable
          initialWorkflows={[makeWorkflow({ id: 'wf-exec-1', name: 'Exec Flow' })]}
          initialMeta={{ ...MOCK_META, total: 1 }}
        />
      );

      // Wait for the exec count to populate.
      const link = await screen.findByRole('link', { name: '42' });
      expect(link).toHaveAttribute('href', '/admin/orchestration/executions?workflowId=wf-exec-1');
    });

    it('renders muted "0" with no link when execution count is 0', async () => {
      mockFetch = makeDispatchedFetch(makeExecCountResponse(0));
      global.fetch = mockFetch as typeof fetch;

      render(
        <WorkflowsTable
          initialWorkflows={[makeWorkflow({ id: 'wf-exec-2', name: 'Zero Flow' })]}
          initialMeta={{ ...MOCK_META, total: 1 }}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('0')).toBeInTheDocument();
      });

      // Must not be wrapped in a link.
      const zeroEl = screen.getByText('0');
      expect(zeroEl.closest('a')).toBeNull();
    });

    it('renders "—" when the execution count fetch fails', async () => {
      const failedExecFetch = vi.fn<typeof fetch>((input: RequestInfo | URL) => {
        const url = toUrlString(input);
        if (url.includes('/executions')) {
          return Promise.resolve(createMockFetchResponse({ success: false }, 500));
        }
        return Promise.resolve(makeWorkflowsListResponse());
      });
      mockFetch = failedExecFetch;
      global.fetch = mockFetch as typeof fetch;

      render(
        <WorkflowsTable
          initialWorkflows={[makeWorkflow({ id: 'wf-exec-3', name: 'Fail Flow' })]}
          initialMeta={{ ...MOCK_META, total: 1 }}
        />
      );

      // The component sets null on failure and renders the em-dash literal "—".
      await waitFor(() => {
        // Multiple "—" may exist (e.g. description column); at least one must be present.
        expect(screen.getAllByText('—').length).toBeGreaterThan(0);
      });
    });
  });
});
