// @vitest-environment happy-dom

/**
 * Unit Test: Event Subscriptions list page
 *
 * @see app/admin/orchestration/event-subscriptions/page.tsx
 *
 * Server component. Asserts the page renders its header, breadcrumb,
 * and the WebhooksTable, that a failed subscriptions load throws to the
 * error boundary rather than rendering an empty list, and that a failed
 * dead-letter queue shows a notice in its tab rather than an empty queue
 * (the all-clear) while the subscriptions still render (#518).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSearchParams } from 'next/navigation';
import { render, screen } from '@testing-library/react';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/webhooks-table', () => ({
  WebhooksTable: ({
    initialWebhooks,
    initialMeta,
  }: {
    initialWebhooks: unknown;
    initialMeta: unknown;
  }) => (
    <div
      data-testid="webhooks-table"
      data-webhooks={JSON.stringify(initialWebhooks)}
      data-meta={JSON.stringify(initialMeta)}
    />
  ),
}));

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import React from 'react';
import EventSubscriptionsPage, {
  metadata,
} from '@/app/admin/orchestration/event-subscriptions/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

/** Answer each endpoint the page reads; a fresh Response per call. */
function routeFetch(answers: { webhooks?: () => Response; dlq?: () => Response }) {
  vi.mocked(serverFetch).mockImplementation(async (path: string) => {
    if (path.startsWith(API.ADMIN.ORCHESTRATION.WEBHOOK_DLQ)) {
      return (answers.dlq ?? (() => apiSuccess([])))();
    }
    return (answers.webhooks ?? (() => apiSuccess([])))();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>
  );
});

describe('EventSubscriptionsPage (list)', () => {
  it('exports metadata with the Event Subscriptions title', () => {
    expect(metadata.title).toBe('Event Subscriptions · AI Orchestration');
  });

  it('renders the header, breadcrumb, and WebhooksTable on a successful fetch', async () => {
    const webhooks = [
      {
        id: 'wh_1',
        url: 'https://example.com/hook',
        events: ['workflow.completed'],
        isActive: true,
        description: 'Test hook',
        createdAt: '2026-05-18T00:00:00Z',
        updatedAt: '2026-05-18T00:00:00Z',
      },
    ];
    routeFetch({
      webhooks: () => apiSuccess(webhooks, { page: 1, limit: 25, total: 1, totalPages: 1 }),
    });

    const ui = await EventSubscriptionsPage();
    render(ui);

    // "Event Subscriptions" appears in both the breadcrumb and the
    // heading; assert on the h1 specifically.
    expect(
      screen.getByRole('heading', { level: 1, name: /Event Subscriptions/ })
    ).toBeInTheDocument();
    expect(screen.getByText('AI Orchestration')).toBeInTheDocument();
    const table = screen.getByTestId('webhooks-table');
    expect(table.getAttribute('data-webhooks')).toBe(JSON.stringify(webhooks));
  });

  it('renders a genuinely empty list as an empty list', async () => {
    routeFetch({});

    const ui = await EventSubscriptionsPage();
    render(ui);

    const table = screen.getByTestId('webhooks-table');
    expect(table.getAttribute('data-webhooks')).toBe('[]');
  });

  // ── A failed load is a failure, not an empty list (#518) ─────────────────

  it('throws to the error boundary when the subscriptions API answers 500', async () => {
    routeFetch({ webhooks: () => apiFailure(500) });

    await expect(EventSubscriptionsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the subscriptions API answers success:false', async () => {
    routeFetch({ webhooks: () => apiFailure(200) });

    await expect(EventSubscriptionsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when fetch rejects', async () => {
    const fetchErr = new Error('network down');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);

    await expect(EventSubscriptionsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.any(String),
      fetchErr,
      expect.any(Object)
    );
  });

  describe('when only the dead-letter queue fails', () => {
    it.each([
      ['answers 500', () => apiFailure(500)],
      ['answers success:false', () => apiFailure(200)],
    ])('still renders the subscriptions when it %s', async (_label, dlq) => {
      routeFetch({ dlq });

      render(await EventSubscriptionsPage());

      expect(screen.getByTestId('webhooks-table')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /dead letter queue/i })).toBeInTheDocument();
    });

    it('shows a notice in the DLQ tab rather than an empty queue', async () => {
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=dlq') as ReturnType<typeof useSearchParams>
      );
      routeFetch({ dlq: () => apiFailure(500) });

      render(await EventSubscriptionsPage());

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load the dead-letter queue/i);
      expect(screen.queryByText(/nothing in the dead-letter queue/i)).not.toBeInTheDocument();
    });
  });
});
