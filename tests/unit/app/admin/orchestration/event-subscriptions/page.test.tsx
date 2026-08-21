// @vitest-environment happy-dom

/**
 * Unit Test: Event Subscriptions list page
 *
 * @see app/admin/orchestration/event-subscriptions/page.tsx
 *
 * Server component. Asserts the page renders its header, breadcrumb,
 * and the WebhooksTable, and that the data path through `serverFetch`
 * / `parseApiResponse` is exercised on both success and failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

beforeEach(() => {
  vi.clearAllMocks();
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
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: webhooks,
      meta: { page: 1, limit: 25, total: 1, totalPages: 1 },
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

  it('falls back to an empty list when the fetch is not ok', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const ui = await EventSubscriptionsPage();
    render(ui);

    const table = screen.getByTestId('webhooks-table');
    expect(table.getAttribute('data-webhooks')).toBe('[]');
  });

  it('falls back to an empty list when the API response indicates failure', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'oh_no', message: 'boom' },
    });

    const ui = await EventSubscriptionsPage();
    render(ui);

    const table = screen.getByTestId('webhooks-table');
    expect(table.getAttribute('data-webhooks')).toBe('[]');
  });

  it('logs and falls back to an empty list when fetch throws', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('network down'));

    const ui = await EventSubscriptionsPage();
    render(ui);

    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    const table = screen.getByTestId('webhooks-table');
    expect(table.getAttribute('data-webhooks')).toBe('[]');
  });
});
