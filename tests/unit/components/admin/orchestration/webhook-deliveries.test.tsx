/**
 * Tests for `components/admin/orchestration/webhook-deliveries.tsx`
 *
 * Key behaviours:
 * - Shows "No deliveries yet." when list is empty
 * - Renders delivery rows: event type badge, status badge, response code, attempts, error
 * - "—" shown for null lastResponseCode and null lastError
 * - Retry button shown only for failed/exhausted deliveries
 * - Retry calls apiClient.post with correct endpoint and refetches
 * - Pagination shown only when totalPages > 1
 * - STATUS_VARIANTS: delivered → default, pending → secondary, failed/exhausted → destructive
 *
 * @see components/admin/orchestration/webhook-deliveries.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebhookDeliveries } from '@/components/admin/orchestration/webhook-deliveries';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPost = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        webhookDeliveries: (id: string) => `/api/v1/admin/orchestration/webhooks/${id}/deliveries`,
        retryDelivery: (id: string) =>
          `/api/v1/admin/orchestration/webhooks/deliveries/${id}/retry`,
      },
    },
  },
}));

vi.mock('@/lib/api/parse-response', () => ({
  parseApiResponse: async (res: Response) => {
    const json = await res.json();
    return json as { success: boolean; data: unknown[]; meta?: unknown };
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    eventType: 'agent.created',
    status: 'delivered',
    lastResponseCode: 200,
    lastError: null,
    attempts: 1,
    createdAt: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
}

function makeMeta(overrides: Record<string, unknown> = {}) {
  return {
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    ...overrides,
  };
}

function mockFetch(deliveries: unknown[], meta = makeMeta({ total: deliveries.length })) {
  const body = JSON.stringify({ success: true, data: deliveries, meta });
  // Use mockImplementation to create a fresh Response per call (body can only be consumed once)
  globalThis.fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebhookDeliveries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPost.mockResolvedValue(undefined);
    mockFetch([]);
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  it('shows "No deliveries yet." when list is empty', async () => {
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => {
      expect(screen.getByText('No deliveries yet.')).toBeInTheDocument();
    });
  });

  // ── Delivery rows ─────────────────────────────────────────────────────────

  it('renders event type, status, response code, and attempts', async () => {
    mockFetch([makeDelivery()]);
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => {
      expect(screen.getByText('Agent Created')).toBeInTheDocument();
      expect(screen.getByText('delivered')).toBeInTheDocument();
      expect(screen.getByText('200')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  it('shows "—" for null lastResponseCode and null lastError', async () => {
    mockFetch([makeDelivery({ lastResponseCode: null, lastError: null })]);
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => {
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows lastError text when present', async () => {
    mockFetch([makeDelivery({ status: 'failed', lastError: 'Connection timeout' })]);
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => {
      expect(screen.getByText('Connection timeout')).toBeInTheDocument();
    });
  });

  it('renders "pending" status badge', async () => {
    mockFetch([makeDelivery({ status: 'pending' })]);
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => {
      expect(screen.getByText('pending')).toBeInTheDocument();
    });
  });

  it('renders "exhausted" status badge', async () => {
    mockFetch([makeDelivery({ status: 'exhausted' })]);
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => {
      expect(screen.getByText('exhausted')).toBeInTheDocument();
    });
  });

  // ── Retry button ──────────────────────────────────────────────────────────

  it('shows retry button for failed deliveries', async () => {
    mockFetch([makeDelivery({ status: 'failed' })]);
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry delivery/i })).toBeInTheDocument();
    });
  });

  it('shows retry button for exhausted deliveries', async () => {
    mockFetch([makeDelivery({ status: 'exhausted' })]);
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry delivery/i })).toBeInTheDocument();
    });
  });

  it('does not show retry button for delivered deliveries', async () => {
    mockFetch([makeDelivery({ status: 'delivered' })]);
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByText('delivered'));
    expect(screen.queryByRole('button', { name: /retry delivery/i })).not.toBeInTheDocument();
  });

  it('calls apiClient.post with retry endpoint on retry click', async () => {
    const user = userEvent.setup();
    mockFetch([makeDelivery({ id: 'del-42', status: 'failed' })]);

    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByRole('button', { name: /retry delivery/i }));

    await user.click(screen.getByRole('button', { name: /retry delivery/i }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/webhooks/deliveries/del-42/retry'
      );
    });
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it('does not show pagination when totalPages is 1', async () => {
    mockFetch([makeDelivery()], makeMeta({ totalPages: 1, total: 1 }));
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByText('delivered'));
    expect(screen.queryByText(/page 1 of/i)).not.toBeInTheDocument();
  });

  it('shows pagination controls when totalPages > 1', async () => {
    mockFetch([makeDelivery()], makeMeta({ page: 1, limit: 20, total: 50, totalPages: 3 }));
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });
  });

  it('Prev button is disabled on first page', async () => {
    mockFetch([makeDelivery()], makeMeta({ page: 1, totalPages: 3, total: 60 }));
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByText(/page 1 of 3/i));
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
  });

  it('Next button is disabled on last page', async () => {
    mockFetch([makeDelivery()], makeMeta({ page: 3, totalPages: 3, total: 60 }));
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByText(/page 3 of 3/i));
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  // ── Retry refetches the list ───────────────────────────────────────────────

  it('refetches deliveries after a successful retry', async () => {
    const user = userEvent.setup();
    mockFetch([makeDelivery({ id: 'del-10', status: 'failed' })]);

    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByRole('button', { name: /retry delivery/i }));

    const callsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /retry delivery/i }));

    await waitFor(() => {
      const callsAfter = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  // ── Page navigation ───────────────────────────────────────────────────────

  it('clicking Next navigates to page 2 and refetches', async () => {
    const user = userEvent.setup();
    mockFetch([makeDelivery()], makeMeta({ page: 1, limit: 20, total: 50, totalPages: 3 }));

    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByText(/page 1 of 3/i));

    const callsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      const callsAfter = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });

    // Verify page=2 was in the fetch URL
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const lastUrl = calls[calls.length - 1][0] as string;
    expect(lastUrl).toContain('page=2');
  });

  it('clicking Prev navigates to previous page and refetches', async () => {
    const user = userEvent.setup();
    mockFetch([makeDelivery()], makeMeta({ page: 2, limit: 20, total: 50, totalPages: 3 }));

    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByText(/page 2 of 3/i));

    const callsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /prev/i }));

    await waitFor(() => {
      const callsAfter = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const lastUrl = calls[calls.length - 1][0] as string;
    expect(lastUrl).toContain('page=1');
  });

  // ── Status filter ─────────────────────────────────────────────────────────

  it('changing status filter to "failed" includes status=failed in fetch URL', async () => {
    const user = userEvent.setup();
    mockFetch([makeDelivery()]);

    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByText('delivered'));

    const statusSelect = screen.getByRole('combobox');
    await user.click(statusSelect);
    await user.click(await screen.findByRole('option', { name: /^failed$/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const lastUrl = calls[calls.length - 1][0] as string;
      expect(lastUrl).toContain('status=failed');
    });
  });

  // ── Timestamp rendering ────────────────────────────────────────────────────

  it('renders a formatted timestamp for each delivery row', async () => {
    mockFetch([makeDelivery({ createdAt: '2026-03-10T14:30:00.000Z' })]);
    render(<WebhookDeliveries webhookId="wh-1" />);
    await waitFor(() => screen.getByText('delivered'));

    // The timestamp cell uses new Date(d.createdAt).toLocaleString()
    // We just verify it contains something date-like (non-empty, not the ISO string)
    const cells = screen.getAllByRole('cell');
    const timestampCell = cells[0]; // First cell in the delivery row is the time
    expect(timestampCell.textContent).toBeTruthy();
    expect(timestampCell.textContent).not.toBe('2026-03-10T14:30:00.000Z');
  });
});
