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
import { render, screen, waitFor } from '@testing-library/react';
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

function renderTable() {
  render(
    <WebhooksTable
      initialWebhooks={[WEBHOOK]}
      initialMeta={{ page: 1, limit: 25, total: 1, totalPages: 1 }}
    />
  );
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
    expect(alert).toHaveTextContent('Webhook is locked by an import');
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
});
