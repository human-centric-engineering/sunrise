/**
 * WebhooksTable Tests
 *
 * Test Coverage:
 * - Renders webhook rows with URL, events, and status
 * - Shows empty state when no webhooks
 * - Create button links to new webhook page
 * - Event overflow badge (+N)
 * - URL truncation
 * - Pagination visible and controls functional
 * - Active filter change triggers refetch
 * - Delete flow (open dialog → confirm → apiClient.delete called)
 * - Toggle-active optimistic revert on error
 *
 * @see components/admin/orchestration/webhooks-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import {
  WebhooksTable,
  type WebhookListItem,
} from '@/components/admin/orchestration/webhooks-table';
import type { PaginationMeta } from '@/types/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
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

// Mock global fetch — returns the MOCK_WEBHOOKS fixture by default so
// the useEffect re-fetch on mount doesn't clear the initial data.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

const MOCK_WEBHOOKS: WebhookListItem[] = [
  {
    id: 'wh-1',
    url: 'https://example.com/hooks/sunrise',
    events: ['budget_exceeded', 'workflow_failed'],
    isActive: true,
    description: 'Slack alerts',
    createdAt: '2026-01-15T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    _count: { deliveries: 12 },
  },
  {
    id: 'wh-2',
    url: 'https://other.com/webhook',
    events: ['message_created'],
    isActive: false,
    description: null,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
    _count: { deliveries: 0 },
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebhooksTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: MOCK_WEBHOOKS,
          meta: { page: 1, limit: 25, total: 2, totalPages: 1 },
        }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Existing tests (keep — do not modify) ───────────────────────────────────

  it('renders webhook rows with URL, description, and delivery count', () => {
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    expect(screen.getByText(/example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/other\.com/)).toBeInTheDocument();
    expect(screen.getByText('Slack alerts')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    // Active toggles rendered as switches
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
  });

  it('shows empty state when no webhooks', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: [],
          meta: { page: 1, limit: 25, total: 0, totalPages: 1 },
        }),
    });
    render(<WebhooksTable initialWebhooks={[]} initialMeta={META} />);

    await waitFor(() => {
      expect(screen.getByText(/no webhook subscriptions yet/i)).toBeInTheDocument();
    });
  });

  it('has a create button linking to new webhook page', () => {
    render(<WebhooksTable initialWebhooks={[]} initialMeta={META} />);

    const link = screen.getByRole('link', { name: /new webhook/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration/webhooks/new');
  });

  it('renders event badges for each webhook', () => {
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    expect(screen.getByText('budget_exceeded')).toBeInTheDocument();
    expect(screen.getByText('workflow_failed')).toBeInTheDocument();
    expect(screen.getByText('message_created')).toBeInTheDocument();
  });

  it('row actions dropdown contains Edit and Delete', async () => {
    const userEvent = await import('@testing-library/user-event');
    const user = userEvent.default.setup();
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
    await user.click(actionBtns[0]);

    expect(await screen.findByRole('menuitem', { name: /edit/i })).toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });

  it('toggling active switch calls apiClient.patch', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

    const userEvent = await import('@testing-library/user-event');
    const user = userEvent.default.setup();
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    const switches = screen.getAllByRole('switch');
    await user.click(switches[0]);

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        expect.stringContaining('/webhooks/wh-1'),
        expect.objectContaining({ body: { isActive: false } })
      );
    });
  });

  // ── New tests ────────────────────────────────────────────────────────────────

  it('shows first 3 event badges and an overflow +2 badge for a webhook with 5 events', () => {
    // Arrange — a webhook with 5 events; only first 3 shown plus "+2"
    const webhookWith5Events: WebhookListItem = {
      id: 'wh-5',
      url: 'https://five.com/hook',
      events: [
        'budget_exceeded',
        'workflow_failed',
        'approval_required',
        'message_created',
        'execution_failed',
      ],
      isActive: true,
      description: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      _count: { deliveries: 0 },
    };

    render(
      <WebhooksTable
        initialWebhooks={[webhookWith5Events]}
        initialMeta={{ ...META, total: 1, totalPages: 1 }}
      />
    );

    // Assert — first 3 events rendered as individual badges
    expect(screen.getByText('budget_exceeded')).toBeInTheDocument();
    expect(screen.getByText('workflow_failed')).toBeInTheDocument();
    expect(screen.getByText('approval_required')).toBeInTheDocument();
    // Assert — overflow badge showing "+2"
    expect(screen.getByText('+2')).toBeInTheDocument();
    // Assert — the 4th and 5th events are NOT shown as individual badges
    expect(screen.queryByText('message_created')).not.toBeInTheDocument();
    expect(screen.queryByText('execution_failed')).not.toBeInTheDocument();
  });

  it('truncates a URL longer than 50 characters with ellipsis', () => {
    // Arrange — URL of 70 characters
    const longUrl = 'https://very-long-domain-name.example.com/webhooks/some/deeply/nested/path';
    expect(longUrl.length).toBeGreaterThan(50);

    const webhookLongUrl: WebhookListItem = {
      id: 'wh-long',
      url: longUrl,
      events: ['budget_exceeded'],
      isActive: true,
      description: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      _count: { deliveries: 0 },
    };

    render(
      <WebhooksTable
        initialWebhooks={[webhookLongUrl]}
        initialMeta={{ ...META, total: 1, totalPages: 1 }}
      />
    );

    // Assert — truncated form with ellipsis is shown
    const truncated = longUrl.slice(0, 50) + '…';
    expect(screen.getByText(truncated)).toBeInTheDocument();
    // Assert — full URL is NOT shown as visible text (it is in the href but not the link text)
    expect(screen.queryByText(longUrl)).not.toBeInTheDocument();
  });

  it('shows pagination controls with correct page info when totalPages > 1', async () => {
    // Arrange — mock returns 3 pages so pagination remains visible after mount refetch
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: MOCK_WEBHOOKS,
          meta: { page: 1, limit: 25, total: 75, totalPages: 3 },
        }),
    });

    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ page: 1, limit: 25, total: 75, totalPages: 3 }}
      />
    );

    // Wait for mount-time refetch to settle — both the page text and
    // the `loading` flag clear in the same render, but assert the
    // enabled-state inside waitFor to avoid a CI race on React batching.
    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled();
    });

    // Assert — Prev and Next buttons rendered
    expect(screen.getByRole('button', { name: /prev/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    // Assert — Prev is disabled on page 1
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
  });

  it('clicking Next advances to page 2 and updates the page indicator', async () => {
    // Arrange — mount-time fetch returns page 1 of 3; Next-button fetch returns page 2 of 3.
    // The mock is set up to respond differently after the first call so we can assert the
    // page indicator updates, which verifies the component processed the response correctly.
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: MOCK_WEBHOOKS,
            meta: { page: 1, limit: 25, total: 75, totalPages: 3 },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: MOCK_WEBHOOKS,
            meta: { page: 2, limit: 25, total: 75, totalPages: 3 },
          }),
      });

    const userEvent = await import('@testing-library/user-event');
    const user = userEvent.default.setup();

    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ page: 1, limit: 25, total: 75, totalPages: 3 }}
      />
    );

    // Wait for the mount-time fetch to settle so pagination is visible and Next is enabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled();
    });

    // Act — click Next
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Assert — the page indicator reflects the response from the page=2 fetch
    await waitFor(() => {
      expect(screen.getByText(/page 2 of 3/i)).toBeInTheDocument();
    });
  });

  it('changing filter to "Active" removes inactive webhooks from the table', async () => {
    // Arrange — mount returns both webhooks; after selecting "Active" the refetch
    // returns only the active one. Asserting the inactive row disappears proves the
    // component used the filtered response to update the list, not just the URL.
    mockFetch
      .mockResolvedValueOnce({
        // mount-time fetch — both webhooks
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: MOCK_WEBHOOKS,
            meta: { page: 1, limit: 25, total: 2, totalPages: 1 },
          }),
      })
      .mockResolvedValueOnce({
        // filter fetch — active only (wh-1)
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: [MOCK_WEBHOOKS[0]],
            meta: { page: 1, limit: 25, total: 1, totalPages: 1 },
          }),
      });

    const userEvent = await import('@testing-library/user-event');
    const user = userEvent.default.setup();

    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    // Wait for mount-time fetch to settle — both rows should be present
    await waitFor(() => {
      expect(screen.getByText(/other\.com/)).toBeInTheDocument();
    });

    // Act — open the status Select and pick "Active"
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Active' }));

    // Assert — the inactive webhook (other.com) is gone; the active one (example.com) remains
    await waitFor(() => {
      expect(screen.queryByText(/other\.com/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/example\.com/)).toBeInTheDocument();
  });

  it('delete flow: opens confirm dialog and calls apiClient.delete on confirm', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockResolvedValue({ success: true });

    const userEvent = await import('@testing-library/user-event');
    const user = userEvent.default.setup();

    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    // Open the row actions dropdown for the first webhook
    const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
    await user.click(actionBtns[0]);

    // Click "Delete" in the dropdown
    const deleteItem = await screen.findByRole('menuitem', { name: /delete/i });
    await user.click(deleteItem);

    // Assert — confirm dialog appears
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();

    // Click the confirmation "Delete" button in the dialog
    const confirmBtn = screen.getByRole('button', { name: /^delete$/i });
    await user.click(confirmBtn);

    // Assert — apiClient.delete called with the correct webhook URL
    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('/webhooks/wh-1'));
    });
  });

  // BUG: fetchPage has no catch block — only a finally. A network error is swallowed via
  // `void fetchPage(1)` and listError is never set, so no error message reaches the UI.
  // This todo documents the CORRECT expected behavior; enable it once the source adds a
  // catch block in fetchPage that calls setListError.
  it.todo('shows an error message when fetchPage encounters a network failure');

  // BUG: handleDelete has no catch block — only a finally. A delete API error is swallowed
  // and no error message reaches the UI. This todo documents the CORRECT expected behavior;
  // enable it once the source adds a catch block in handleDelete that calls setListError.
  it.todo('shows an error message when apiClient.delete fails during delete confirmation');

  it('toggle-active optimistic revert: reverts switch and shows error banner on patch failure', async () => {
    // Arrange
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(new APIClientError('fail', 'X', 500));

    const userEvent = await import('@testing-library/user-event');
    const user = userEvent.default.setup();

    // wh-1 starts as isActive: true
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    const switches = screen.getAllByRole('switch');
    // First switch corresponds to wh-1 (isActive: true)
    expect(switches[0]).toHaveAttribute('aria-checked', 'true');

    // Act — click the switch (optimistic update flips it to false, then revert on error)
    await user.click(switches[0]);

    // Assert — after the error, the switch reverts to its original state (true)
    await waitFor(() => {
      expect(switches[0]).toHaveAttribute('aria-checked', 'true');
    });

    // Assert — error banner shown with the APIClientError message
    await waitFor(() => {
      expect(screen.getByText(/could not update webhook: fail/i)).toBeInTheDocument();
    });
  });
});
