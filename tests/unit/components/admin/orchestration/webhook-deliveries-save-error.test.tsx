// @vitest-environment happy-dom

/**
 * WebhookDeliveries — failed retry (§124)
 *
 * A refused row retry shows in the one box above the table, which takes focus.
 *
 * @see components/admin/orchestration/webhook-deliveries.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WebhookDeliveries } from '@/components/admin/orchestration/webhook-deliveries';

// The real APIClientError, so the table reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const DELIVERY = {
  id: 'del-1',
  eventType: 'workflow_failed',
  status: 'failed',
  lastResponseCode: 500,
  lastError: 'upstream down',
  attempts: 3,
  createdAt: '2026-01-01T00:00:00Z',
};

describe('WebhookDeliveries — failed retry', () => {
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
              data: [DELIVERY],
              meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
  });

  it('shows the refusal in the box above the table, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Subscription is inactive', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<WebhookDeliveries webhookId="wh-1" />);

    await user.click(await screen.findByTitle('Retry delivery'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Subscription is inactive');
    expect(alert.compareDocumentPosition(screen.getByRole('table'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
