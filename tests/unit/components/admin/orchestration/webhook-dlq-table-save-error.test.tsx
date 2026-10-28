// @vitest-environment happy-dom

/**
 * WebhookDlqTable — failed actions (§124)
 *
 * A refused row retry shows in the one box above the table, which takes
 * focus. A refused discard shows inside its dialog, which used to close and
 * show it behind the overlay; it now stays open.
 *
 * @see components/admin/orchestration/webhook-dlq-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  WebhookDlqTable,
  type DlqDelivery,
} from '@/components/admin/orchestration/webhook-dlq-table';

// The real APIClientError, so the table reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const DELIVERY: DlqDelivery = {
  id: 'del-1',
  eventType: 'workflow_failed',
  status: 'exhausted',
  lastResponseCode: 500,
  lastError: 'upstream down',
  attempts: 5,
  createdAt: '2026-01-01T00:00:00Z',
  lastAttemptAt: '2026-01-01T01:00:00Z',
  destination: 'https://example.com',
  subscriptionId: 'wh-1',
  subscription: { id: 'wh-1', description: 'Slack' },
};

const META = { page: 1, limit: 20, total: 1, totalPages: 1 };

const DELIVERY_B: DlqDelivery = {
  ...DELIVERY,
  id: 'del-2',
  subscriptionId: 'wh-2',
  subscription: { id: 'wh-2', description: 'Teams' },
};

function renderTable(deliveries: DlqDelivery[] = [DELIVERY]) {
  render(
    <WebhookDlqTable
      initialDeliveries={deliveries}
      initialMeta={{ ...META, total: deliveries.length }}
      subscriptions={[{ id: 'wh-1', url: 'https://example.com/hook', description: 'Slack' }]}
    />
  );
}

describe('WebhookDlqTable — failed actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [DELIVERY], meta: META }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
  });

  it('shows a refused retry in the box above the table, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Subscription is inactive', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByTitle('Retry delivery'));

    const alert = await screen.findByRole('alert');
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent(
      'Couldn\'t retry the delivery to "Slack": Subscription is inactive'
    );
    expect(alert.compareDocumentPosition(screen.getByRole('table'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('keeps the discard dialog open with the refusal inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Delivery is being retried', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByTitle('Discard from DLQ'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Delivery is being retried');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
  });

  it('words a retry the server said nothing about as the hook does: the context, then "Try again."', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Failed to fetch', 'NETWORK_ERROR', 0)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByTitle('Retry delivery'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Couldn't retry the delivery to "Slack"\. Try again\.$/
    );
  });

  it('commits the dialog to a discard in flight: both buttons disabled, a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    let answer: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve(undefined)))
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByTitle('Discard from DLQ'));
    const dialog = await screen.findByRole('alertdialog');
    const action = within(dialog).getByRole('button', { name: /^delete$/i });
    await user.click(action);

    expect(action).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(action);
    expect(apiClient.delete).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps row A's late failure in row A's dialog, never in row B's", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: [DELIVERY, DELIVERY_B],
              meta: { ...META, total: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
    let refuse: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(new APIClientError('Row A is being retried', 'CONFLICT', 409));
        })
    );
    const user = userEvent.setup();
    renderTable([DELIVERY, DELIVERY_B]);

    await screen.findByText('Teams');
    await user.click(screen.getAllByTitle('Discard from DLQ')[0]);
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // Escape while the discard runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    refuse();

    dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Row A is being retried');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getAllByTitle('Discard from DLQ')[1]);
    await screen.findByRole('alertdialog');
    expect(screen.queryByText(/Row A is being retried/)).not.toBeInTheDocument();
  });
});
