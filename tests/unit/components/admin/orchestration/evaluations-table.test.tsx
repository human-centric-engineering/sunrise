/**
 * EvaluationsTable Component Tests
 *
 * Test Coverage:
 * - Initial render with evaluation fixtures (titles, badges)
 * - Empty state when no evaluations
 * - New Evaluation button links to /admin/orchestration/evaluations/new
 * - Debounced search (300ms) triggers refetch
 * - Status filter triggers refetch
 * - Agent filter triggers refetch
 * - Pagination: Previous disabled on page 1, Next fires fetch with page=2
 * - Status badges render with correct text
 * - Row action menu with archive option
 * - Archive confirmation dialog + PATCH call
 * - No action menu for already-archived evaluations
 *
 * @see components/admin/orchestration/evaluations-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

vi.mock('@/lib/api/parse-response', () => ({
  parseApiResponse: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { EvaluationsTable } from '@/components/admin/orchestration/evaluations-table';
import { parseApiResponse } from '@/lib/api/parse-response';
import type { PaginationMeta } from '@/types/api';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_EVALUATIONS = [
  {
    id: 'ev-1',
    title: 'Tone Check',
    status: 'draft',
    agent: { id: 'a1', name: 'Bot A', slug: 'bot-a' },
    _count: { logs: 2 },
    createdAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'ev-2',
    title: 'Safety Audit',
    status: 'completed',
    agent: { id: 'a2', name: 'Bot B', slug: 'bot-b' },
    _count: { logs: 5 },
    createdAt: '2025-01-02T00:00:00.000Z',
  },
];

const MOCK_META: PaginationMeta = { page: 1, limit: 25, total: 2, totalPages: 1 };

const MOCK_AGENTS = [
  { id: 'a1', name: 'Bot A' },
  { id: 'a2', name: 'Bot B' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Extract a URL string from any fetch RequestInfo | URL argument. */
function toUrlString(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  return url.url; // Request object
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluationsTable', () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn<typeof fetch>();
    global.fetch = mockFetch as typeof fetch;

    // Default: returns evaluations list
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({ success: true, data: MOCK_EVALUATIONS, meta: MOCK_META }))
    );

    // Default parseApiResponse: return evaluations list shape
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MOCK_EVALUATIONS,
      meta: MOCK_META,
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders evaluation titles in the table', () => {
      // Arrange & Act
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Assert
      expect(screen.getByText('Tone Check')).toBeInTheDocument();
      expect(screen.getByText('Safety Audit')).toBeInTheDocument();
    });

    it('renders table headers', () => {
      // Arrange & Act
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Assert
      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Agent')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
    });

    it('renders "No evaluations found." when list is empty', () => {
      // Arrange & Act
      render(
        <EvaluationsTable
          initialEvaluations={[]}
          initialMeta={{ ...MOCK_META, total: 0 }}
          agents={MOCK_AGENTS}
        />
      );

      // Assert
      expect(screen.getByText('No evaluations found.')).toBeInTheDocument();
    });

    it('New Evaluation button links to /admin/orchestration/evaluations/new', () => {
      // Arrange & Act
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Assert: link to new evaluation page
      const link = screen.getByRole('link', { name: /new evaluation/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/admin/orchestration/evaluations/new');
    });

    it('renders status badges with correct text', () => {
      // Arrange & Act
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Assert: Draft and Completed badges
      expect(screen.getByText('Draft')).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });
  });

  // ── Search / debounce ──────────────────────────────────────────────────────

  describe('search with debounce', () => {
    it('does not fetch immediately on typing', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );
      const initial = mockFetch.mock.calls.length;

      // Act
      await user.type(screen.getByPlaceholderText(/search evaluations/i), 'to');

      // Assert: no extra fetches before debounce fires
      expect(mockFetch.mock.calls.length).toBe(initial);
    });

    it('fires refetch after 300ms debounce with search query', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Act: type and wait for debounce
      await user.type(screen.getByPlaceholderText(/search evaluations/i), 'tone');

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Assert: a fetch was fired containing the query
      await waitFor(() => {
        const urls = mockFetch.mock.calls.map((call) => toUrlString(call[0] as RequestInfo | URL));
        expect(urls.some((u) => u.includes('q=tone'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });
    });
  });

  // ── Filters ────────────────────────────────────────────────────────────────

  describe('status filter', () => {
    it('selecting a status triggers refetch', async () => {
      // Arrange
      const user = userEvent.setup();
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Act: open status select (second combobox — after agent filter) and choose "Completed"
      const allComboboxes = screen.getAllByRole('combobox');
      // Status combobox is the second one (after agent filter)
      const statusCombobox = allComboboxes[1];

      await user.click(statusCombobox);

      // Select "Completed" option from popover
      const completedOption = await screen.findByRole('option', { name: /^completed$/i });
      await user.click(completedOption);

      // Assert: a fetch was fired containing status=completed
      await waitFor(() => {
        const urls = mockFetch.mock.calls.map((call) => toUrlString(call[0] as RequestInfo | URL));
        expect(urls.some((u) => u.includes('status=completed'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });
    });
  });

  describe('agent filter', () => {
    it('selecting an agent triggers refetch', async () => {
      // Arrange
      const user = userEvent.setup();
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Act: open agent filter (first combobox) and choose "Bot A"
      const allComboboxes = screen.getAllByRole('combobox');
      const agentCombobox = allComboboxes[0];

      await user.click(agentCombobox);

      const botAOption = await screen.findByRole('option', { name: /bot a/i });
      await user.click(botAOption);

      // Assert: a fetch was fired containing the agent id
      await waitFor(() => {
        const urls = mockFetch.mock.calls.map((call) => toUrlString(call[0] as RequestInfo | URL));
        expect(urls.some((u) => u.includes('agentId=a1'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });
    });
  });

  // ── Pagination ─────────────────────────────────────────────────────────────

  describe('pagination boundary behaviour', () => {
    it('Previous button is disabled on page 1', () => {
      // Arrange & Act
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Assert
      const prevBtn = screen.getByRole('button', { name: /previous/i });
      expect(prevBtn).toBeDisabled();
    });

    it('Next button is disabled on the last page', () => {
      // Arrange: page 1 of 1 (already on last page)
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Assert
      const nextBtn = screen.getByRole('button', { name: /^next/i });
      expect(nextBtn).toBeDisabled();
    });

    it('Next button fires fetch with page=2 when on page 1 of 2', async () => {
      // Arrange: page 1 of 2
      const meta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };

      const user = userEvent.setup();
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={meta}
          agents={MOCK_AGENTS}
        />
      );

      // Act: click Next
      const nextBtn = screen.getByRole('button', { name: /^next/i });
      expect(nextBtn).not.toBeDisabled();
      await user.click(nextBtn);

      // Assert: a fetch with page=2 was fired
      await waitFor(() => {
        const urls = mockFetch.mock.calls.map((call) => toUrlString(call[0] as RequestInfo | URL));
        expect(urls.some((u) => u.includes('page=2'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });
    });
  });

  // ── Archive action ────────────────────────────────────────────────────────

  describe('archive action', () => {
    it('renders action menu button for non-archived evaluations', () => {
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Both evaluations (draft, completed) should have action buttons
      const actionButtons = screen.getAllByRole('button', { name: /actions/i });
      expect(actionButtons.length).toBe(2);
    });

    it('does not render action menu for archived evaluations', () => {
      const archivedEval = [{ ...MOCK_EVALUATIONS[0], status: 'archived' }];

      render(
        <EvaluationsTable
          initialEvaluations={archivedEval}
          initialMeta={{ ...MOCK_META, total: 1 }}
          agents={MOCK_AGENTS}
        />
      );

      expect(screen.queryByRole('button', { name: /actions/i })).not.toBeInTheDocument();
    });

    it('shows confirmation dialog when Archive is clicked from menu', async () => {
      const user = userEvent.setup();
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Open first row's action menu
      const actionButtons = screen.getAllByRole('button', { name: /actions/i });
      await user.click(actionButtons[0]);

      // Click Archive in menu
      const archiveMenuItem = await screen.findByRole('menuitem', { name: /archive/i });
      await user.click(archiveMenuItem);

      // Confirmation dialog should appear
      await waitFor(() => {
        expect(screen.getByText(/archive evaluation\?/i)).toBeInTheDocument();
      });
    });

    it('PATCHes status to archived and removes row on confirm', async () => {
      const user = userEvent.setup();
      render(
        <EvaluationsTable
          initialEvaluations={MOCK_EVALUATIONS}
          initialMeta={MOCK_META}
          agents={MOCK_AGENTS}
        />
      );

      // Open menu and click Archive
      const actionButtons = screen.getAllByRole('button', { name: /actions/i });
      await user.click(actionButtons[0]);
      const archiveMenuItem = await screen.findByRole('menuitem', { name: /archive/i });
      await user.click(archiveMenuItem);

      // Confirm in dialog
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      });
      const dialog = screen.getByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: /^archive$/i }));

      // Verify PATCH call with status: 'archived'
      await waitFor(() => {
        const patchCalls = mockFetch.mock.calls.filter((call) => {
          const opts = call[1];
          if (opts?.method !== 'PATCH') return false;
          try {
            const body = JSON.parse(opts.body as string) as { status?: string };
            return body.status === 'archived';
          } catch {
            return false;
          }
        });
        expect(patchCalls.length).toBe(1);
      });

      // Row should be removed from table
      await waitFor(() => {
        expect(screen.queryByText('Tone Check')).not.toBeInTheDocument();
      });
    });
  });
});
