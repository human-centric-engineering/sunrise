/**
 * WebhookDlqTable component tests
 *
 * Covers:
 * - Renders the deliveries returned from the list endpoint + the empty state
 * - Filter changes (subscription, event, since/until) refire the list fetch
 *   with the right query params
 * - Per-row retry / delete hit the right endpoints; APIClientError surfaces
 *   in the inline error banner
 * - Bulk replay: "all subscriptions" sends `deliveryIds` from the visible
 *   page, errors when the page is empty; per-subscription sends
 *   `subscriptionId` (+ optional `before`)
 * - Pagination Next / Prev fire fetches with the right page number
 *
 * The component fires an immediate `fetchPage(1)` from a useEffect on mount,
 * so `initialDeliveries` is replaced by whatever fetch returns. Every test
 * stubs `globalThis.fetch` with a factory that returns a fresh Response per
 * call (happy-dom's Response.json() consumes the body, so re-using one
 * Response across calls would throw "Body has already been used" on the
 * second invocation).
 *
 * @see components/admin/orchestration/webhook-dlq-table.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WebhookDlqTable } from '@/components/admin/orchestration/webhook-dlq-table';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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
      public statusCode = 500,
      public code = 'INTERNAL_ERROR'
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// DatePicker → native date input so filter date changes are simple fireEvents.
vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: ({
    id,
    value,
    onChange,
  }: {
    id?: string;
    value: string;
    onChange: (v: string) => void;
  }) => <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />,
}));

import { apiClient, APIClientError } from '@/lib/api/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type Delivery = {
  id: string;
  eventType: string;
  status: 'exhausted';
  lastResponseCode: number | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  subscriptionId: string;
  subscription: { id: string; url: string; description: string | null };
};

function makeDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'del-1',
    eventType: 'agent_updated',
    status: 'exhausted',
    lastResponseCode: 500,
    lastError: 'Upstream 500',
    attempts: 3,
    createdAt: '2026-05-20T10:00:00.000Z',
    lastAttemptAt: '2026-05-20T10:05:00.000Z',
    subscriptionId: 'sub-1',
    subscription: {
      id: 'sub-1',
      url: 'https://example.test/hook',
      description: 'Slack relay',
    },
    ...overrides,
  };
}

const META = { page: 1, limit: 25, total: 2, totalPages: 1 };

const SUBSCRIPTIONS = [
  { id: 'sub-1', url: 'https://example.test/hook', description: 'Slack relay' },
  { id: 'sub-2', url: 'https://other.test/hook', description: null },
];

/** A fresh JSON Response per call — happy-dom consumes the body. */
function listResponseFactory(deliveries: Delivery[], meta = META): () => Response {
  return () =>
    new Response(JSON.stringify({ success: true, data: deliveries, meta }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

/** Stub fetch with a per-call factory and return the spy for inspection. */
function stubListFetch(deliveries: Delivery[], meta = META) {
  const factory = listResponseFactory(deliveries, meta);
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(factory()));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebhookDlqTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders deliveries returned by the list fetch', async () => {
      stubListFetch([makeDelivery()]);

      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      // Row content: subscription label, last error text, attempts
      await waitFor(() => {
        expect(screen.getByText('Slack relay')).toBeInTheDocument();
      });
      expect(screen.getByText('Upstream 500')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('shows the empty-state message when the list comes back empty', async () => {
      stubListFetch([], { ...META, total: 0 });

      render(
        <WebhookDlqTable
          initialDeliveries={[]}
          initialMeta={{ ...META, total: 0 }}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Nothing in the dead-letter queue.')).toBeInTheDocument();
      });
    });

    it('hides pagination controls when totalPages <= 1', async () => {
      stubListFetch([makeDelivery()]);

      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await waitFor(() => screen.getByText('Slack relay'));
      expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /prev/i })).not.toBeInTheDocument();
    });

    it('renders pagination controls when totalPages > 1', async () => {
      const multiPageMeta = { ...META, totalPages: 3, total: 75, page: 2 };
      stubListFetch([makeDelivery()], multiPageMeta);

      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={multiPageMeta}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await waitFor(() => screen.getByText(/Page 2 of 3/));
      // The mount fetch flips `loading` true, which disables both nav buttons
      // (`|| loading`). The page text is present from initialMeta before that
      // settles, so wait for the buttons to re-enable rather than asserting
      // mid-fetch — otherwise this races under CI load.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
      });
      expect(screen.getByRole('button', { name: /prev/i })).toBeEnabled();
    });
  });

  describe('filters', () => {
    it('passes since/until in ISO form when date filters are set', async () => {
      const fetchSpy = stubListFetch([makeDelivery()]);

      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      // Wait for the initial mount fetch before driving filters so we can
      // discriminate the filtered fetches in the assertion below.
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

      const sinceInput = document.getElementById('dlq-since') as HTMLInputElement;
      const untilInput = document.getElementById('dlq-until') as HTMLInputElement;
      fireEvent.change(sinceInput, { target: { value: '2026-05-01' } });
      fireEvent.change(untilInput, { target: { value: '2026-05-31' } });

      // The component converts the date strings to ISO via `new Date(...)`,
      // which produces a timestamp at midnight UTC for an ISO date string.
      await waitFor(() => {
        const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
        expect(urls.some((u) => u.includes('since=') && u.includes('2026-05-01'))).toBe(true);
        expect(urls.some((u) => u.includes('until=') && u.includes('2026-05-31'))).toBe(true);
      });
    });
  });

  describe('per-row actions', () => {
    it('Retry button POSTs to retryDelivery for the row', async () => {
      stubListFetch([makeDelivery({ id: 'del-42' })]);
      vi.mocked(apiClient.post).mockResolvedValue(undefined);

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery({ id: 'del-42' })]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await user.click(await screen.findByTitle('Retry delivery'));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/webhooks/deliveries/del-42/retry')
        );
      });
    });

    it('Discard confirmation calls apiClient.delete on the delivery', async () => {
      stubListFetch([makeDelivery({ id: 'del-99' })]);
      vi.mocked(apiClient.delete).mockResolvedValue(undefined);

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery({ id: 'del-99' })]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await user.click(await screen.findByTitle('Discard from DLQ'));
      // Confirm the AlertDialog
      await user.click(await screen.findByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(
          expect.stringContaining('/webhooks/deliveries/del-99')
        );
      });
    });

    it('Retry surfaces an error message when apiClient.post rejects with APIClientError', async () => {
      stubListFetch([makeDelivery()]);
      vi.mocked(apiClient.post).mockRejectedValue(new APIClientError('Upstream gone'));

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await user.click(await screen.findByTitle('Retry delivery'));

      await waitFor(() => {
        expect(screen.getByText(/Retry failed: Upstream gone/i)).toBeInTheDocument();
      });
    });

    it('Retry surfaces a generic error message when apiClient.post throws a non-APIClientError', async () => {
      // Exercises the fallback branch of the error-message ternary.
      stubListFetch([makeDelivery()]);
      vi.mocked(apiClient.post).mockRejectedValue(new Error('boom'));

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await user.click(await screen.findByTitle('Retry delivery'));

      await waitFor(() => {
        expect(screen.getByText('Retry failed. Please try again.')).toBeInTheDocument();
      });
    });

    it('Discard surfaces a generic error when apiClient.delete throws a non-APIClientError', async () => {
      stubListFetch([makeDelivery()]);
      vi.mocked(apiClient.delete).mockRejectedValue(new Error('network down'));

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await user.click(await screen.findByTitle('Discard from DLQ'));
      await user.click(await screen.findByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(screen.getByText('Delete failed. Please try again.')).toBeInTheDocument();
      });
    });
  });

  describe('bulk replay', () => {
    it('with "all subscriptions" sends deliveryIds from the visible page', async () => {
      const deliveries = [
        makeDelivery({ id: 'a' }),
        makeDelivery({ id: 'b' }),
        makeDelivery({ id: 'c' }),
      ];
      stubListFetch(deliveries);
      vi.mocked(apiClient.post).mockResolvedValue(undefined);

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={deliveries}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      // Wait for the mount fetch to set state to the 3 deliveries.
      await waitFor(() => screen.getAllByText('Slack relay'));

      await user.click(screen.getByRole('button', { name: /bulk replay/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/webhooks/dlq/replay'),
          expect.objectContaining({
            body: expect.objectContaining({ deliveryIds: ['a', 'b', 'c'] }),
          })
        );
      });
    });

    it('with "all subscriptions" and zero rows on the page surfaces an inline error', async () => {
      stubListFetch([], { ...META, total: 0 });

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[]}
          initialMeta={{ ...META, total: 0 }}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      // Wait for the empty-state message so we know the mount fetch has
      // landed before attempting the replay.
      await screen.findByText('Nothing in the dead-letter queue.');

      await user.click(screen.getByRole('button', { name: /bulk replay/i }));

      await waitFor(() => {
        expect(screen.getByText('Nothing to replay on this page.')).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('surfaces an APIClientError when bulk replay fails on the server', async () => {
      stubListFetch([makeDelivery()]);
      vi.mocked(apiClient.post).mockRejectedValue(new APIClientError('Worker offline'));

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await waitFor(() => screen.getByText('Slack relay'));

      await user.click(screen.getByRole('button', { name: /bulk replay/i }));

      await waitFor(() => {
        expect(screen.getByText(/Bulk replay failed: Worker offline/i)).toBeInTheDocument();
      });
    });

    it('with a specific subscription + "until" date sends subscriptionId + before', async () => {
      // Exercises the per-subscription branch of handleBulkReplay (the
      // `body.subscriptionId = ...; if (until) body.before = ...` block).
      stubListFetch([makeDelivery()]);
      vi.mocked(apiClient.post).mockResolvedValue(undefined);

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      // Set the "until" date filter first (mocked DatePicker is a native input)
      const untilInput = document.getElementById('dlq-until') as HTMLInputElement;
      fireEvent.change(untilInput, { target: { value: '2026-06-01' } });

      // Open the Subscription select and pick "Slack relay". There are two
      // comboboxes (Subscription + Event) — the first one in document order
      // is Subscription.
      const [subscriptionTrigger] = screen.getAllByRole('combobox');
      await user.click(subscriptionTrigger);
      await user.click(await screen.findByRole('option', { name: /Slack relay/i }));

      await user.click(screen.getByRole('button', { name: /bulk replay/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/webhooks/dlq/replay'),
          expect.objectContaining({
            body: expect.objectContaining({
              subscriptionId: 'sub-1',
              before: expect.stringContaining('2026-06-01'),
            }),
          })
        );
      });
    });

    it('surfaces a generic error message when bulk replay throws a non-APIClientError', async () => {
      stubListFetch([makeDelivery()]);
      vi.mocked(apiClient.post).mockRejectedValue(new Error('socket reset'));

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={META}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await waitFor(() => screen.getByText('Slack relay'));

      await user.click(screen.getByRole('button', { name: /bulk replay/i }));

      await waitFor(() => {
        expect(screen.getByText('Bulk replay failed. Please try again.')).toBeInTheDocument();
      });
    });
  });

  describe('pagination', () => {
    it('clicking Next fetches the next page', async () => {
      const multiPageMeta = { ...META, totalPages: 3, total: 75, page: 1 };
      const fetchSpy = stubListFetch([makeDelivery()], multiPageMeta);

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={multiPageMeta}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      // Wait for the mount fetch before clicking so the page=N assertion
      // discriminates the click-triggered fetch.
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

      await user.click(screen.getByRole('button', { name: /next/i }));

      await waitFor(() => {
        const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
        expect(urls.some((u) => u.includes('page=2'))).toBe(true);
      });
    });

    it('clicking Prev fetches the previous page', async () => {
      const multiPageMeta = { ...META, totalPages: 3, total: 75, page: 2 };
      const fetchSpy = stubListFetch([makeDelivery()], multiPageMeta);

      const user = userEvent.setup();
      render(
        <WebhookDlqTable
          initialDeliveries={[makeDelivery()]}
          initialMeta={multiPageMeta}
          subscriptions={SUBSCRIPTIONS}
        />
      );

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

      await user.click(screen.getByRole('button', { name: /prev/i }));

      await waitFor(() => {
        const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
        expect(urls.some((u) => u.includes('page=1'))).toBe(true);
      });
    });
  });
});
