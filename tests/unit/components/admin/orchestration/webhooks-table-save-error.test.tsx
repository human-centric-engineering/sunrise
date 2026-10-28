// @vitest-environment happy-dom

/**
 * WebhooksTable — failed save (§124)
 *
 * A refused row toggle shows in the one box above the table, which takes
 * focus; a refused delete shows inside its dialog, which stays open.
 *
 * @see components/admin/orchestration/webhooks-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  WebhooksTable,
  type WebhookListItem,
} from '@/components/admin/orchestration/webhooks-table';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// The real APIClientError, so the table reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const WEBHOOK: WebhookListItem = {
  id: 'wh-1',
  url: 'https://example.com/hooks/sunrise',
  events: ['budget_exceeded'],
  agentIds: [],
  workflowIds: [],
  isActive: true,
  description: null,
  createdAt: '2026-01-15T00:00:00Z',
  updatedAt: '2026-01-15T00:00:00Z',
  _count: { deliveries: 0 },
  version: '"v1"',
};

const WEBHOOK_B: WebhookListItem = {
  ...WEBHOOK,
  id: 'wh-2',
  url: 'https://example.org/beta',
};

function renderTable(webhooks: WebhookListItem[] = [WEBHOOK]) {
  render(
    <WebhooksTable
      initialWebhooks={webhooks}
      initialMeta={{ page: 1, limit: 25, total: webhooks.length, totalPages: 1 }}
    />
  );
}

/** Opens row `index`'s delete dialog from its actions menu. */
async function openDelete(user: ReturnType<typeof userEvent.setup>, index: number) {
  await user.click(screen.getAllByRole('button', { name: /row actions/i })[index]);
  await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
  return screen.findByRole('alertdialog');
}

describe('WebhooksTable — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: [WEBHOOK],
              meta: { page: 1, limit: 25, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
  });

  it('shows a refused toggle in the box above the table, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Webhook is locked by an import', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('switch'));

    const alert = await screen.findByRole('alert');
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent(
      'Couldn\'t update "https://example.com/hooks/sunrise": Webhook is locked by an import'
    );
    // Above the table, not inside it.
    expect(alert.compareDocumentPosition(screen.getByRole('table'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('keeps the delete dialog open with the refusal inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Subscription has deliveries in flight', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: /row actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Subscription has deliveries in flight');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('commits the dialog to a delete in flight: both buttons disabled, a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    let answer: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve(undefined)))
    );
    const user = userEvent.setup();
    renderTable();

    const dialog = await openDelete(user, 0);
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
    let refuse: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(new APIClientError('Row A is busy', 'CONFLICT', 409));
        })
    );
    // The list re-reads on mount: serve both rows.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: [WEBHOOK, WEBHOOK_B],
              meta: { page: 1, limit: 25, total: 2, totalPages: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
    const user = userEvent.setup();
    renderTable([WEBHOOK, WEBHOOK_B]);

    let dialog = await openDelete(user, 0);
    expect(dialog).toHaveTextContent('example.com/hooks/sunrise');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // Escape while the delete runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    refuse();

    dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('example.com/hooks/sunrise');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Row A is busy');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    dialog = await openDelete(user, 1);
    expect(dialog).toHaveTextContent('example.org/beta');
    expect(screen.queryByText(/Row A is busy/)).not.toBeInTheDocument();
  });
});
