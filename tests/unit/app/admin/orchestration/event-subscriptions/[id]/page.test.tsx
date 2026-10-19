// @vitest-environment happy-dom

/**
 * Unit Test: Event subscription detail (edit) page
 *
 * @see app/admin/orchestration/event-subscriptions/[id]/page.tsx
 *
 * Server component. Fetches the webhook by id; calls `notFound()` on a
 * 404 and only on a 404 — any other failure throws to the error boundary
 * rather than reading as a missing subscription (#518); otherwise renders
 * WebhookForm + test button + delivery list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  // Throwing from `notFound()` mirrors Next.js's real control flow:
  // the function never returns normally; it throws a sentinel the
  // framework catches to render the 404 page.
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useSearchParams: () => ({ get: () => null }),
}));

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/webhook-form', () => ({
  WebhookForm: ({ mode, webhook }: { mode: string; webhook?: unknown }) => (
    <div
      data-testid="webhook-form"
      data-mode={mode}
      data-webhook={webhook ? JSON.stringify(webhook) : ''}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/webhook-test-button', () => ({
  WebhookTestButton: ({ webhookId }: { webhookId: string }) => (
    <button data-testid="webhook-test-button" data-id={webhookId}>
      Test
    </button>
  ),
}));

vi.mock('@/components/admin/orchestration/webhook-deliveries', () => ({
  WebhookDeliveries: ({ webhookId }: { webhookId: string }) => (
    <div data-testid="webhook-deliveries" data-id={webhookId} />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import React from 'react';
import EventSubscriptionDetailPage, {
  metadata,
} from '@/app/admin/orchestration/event-subscriptions/[id]/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { notFound } from 'next/navigation';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const webhookFixture = {
  id: 'wh_1',
  url: 'https://example.com/hook',
  events: ['workflow.completed'],
  isActive: true,
  description: 'Demo hook',
  createdAt: '2026-05-18T00:00:00Z',
  updatedAt: '2026-05-18T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EventSubscriptionDetailPage', () => {
  it('exports metadata with the edit-subscription title', () => {
    expect(metadata.title).toBe('Edit Event Subscription · AI Orchestration');
  });

  it('renders WebhookForm (edit mode), test button, and deliveries on success', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(webhookFixture));

    const ui = await EventSubscriptionDetailPage({ params: Promise.resolve({ id: 'wh_1' }) });
    render(ui);

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      API.ADMIN.ORCHESTRATION.webhookById('wh_1')
    );
    const form = screen.getByTestId('webhook-form');
    expect(form.getAttribute('data-mode')).toBe('edit');
    expect(form.getAttribute('data-webhook')).toBe(JSON.stringify(webhookFixture));
    expect(screen.getByTestId('webhook-test-button').getAttribute('data-id')).toBe('wh_1');
    expect(screen.getByTestId('webhook-deliveries').getAttribute('data-id')).toBe('wh_1');
  });

  it('calls notFound() when the subscription does not exist', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(404, 'NOT_FOUND'));

    await expect(
      EventSubscriptionDetailPage({ params: Promise.resolve({ id: 'wh_1' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(vi.mocked(notFound)).toHaveBeenCalledOnce();
  });

  // ── A failed load is a failure, not a missing subscription (#518) ────────

  it('throws to the error boundary, not notFound(), when the API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(
      EventSubscriptionDetailPage({ params: Promise.resolve({ id: 'wh_1' }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(notFound)).not.toHaveBeenCalled();
  });

  it('throws, not notFound(), when the API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(
      EventSubscriptionDetailPage({ params: Promise.resolve({ id: 'wh_1' }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(notFound)).not.toHaveBeenCalled();
  });

  it('logs and throws, not notFound(), when fetch rejects', async () => {
    const fetchErr = new Error('network down');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);

    await expect(
      EventSubscriptionDetailPage({ params: Promise.resolve({ id: 'wh_1' }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.any(String),
      fetchErr,
      expect.any(Object)
    );
    expect(vi.mocked(notFound)).not.toHaveBeenCalled();
  });
});
