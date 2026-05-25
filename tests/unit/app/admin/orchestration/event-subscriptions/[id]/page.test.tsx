/**
 * Unit Test: Event subscription detail (edit) page
 *
 * @see app/admin/orchestration/event-subscriptions/[id]/page.tsx
 *
 * Server component. Fetches the webhook by id; calls `notFound()` on a
 * missing or failed fetch; otherwise renders WebhookForm + test button
 * + delivery list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  // Throwing from `notFound()` mirrors Next.js's real control flow:
  // the function never returns normally; it throws a sentinel the
  // framework catches to render the 404 page.
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { notFound } from 'next/navigation';

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
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: webhookFixture,
    });

    const ui = await EventSubscriptionDetailPage({ params: Promise.resolve({ id: 'wh_1' }) });
    render(ui);

    const form = screen.getByTestId('webhook-form');
    expect(form.getAttribute('data-mode')).toBe('edit');
    expect(form.getAttribute('data-webhook')).toBe(JSON.stringify(webhookFixture));
    expect(screen.getByTestId('webhook-test-button').getAttribute('data-id')).toBe('wh_1');
    expect(screen.getByTestId('webhook-deliveries').getAttribute('data-id')).toBe('wh_1');
  });

  it('calls notFound() when the API responds not-ok', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    await expect(
      EventSubscriptionDetailPage({ params: Promise.resolve({ id: 'wh_1' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(vi.mocked(notFound)).toHaveBeenCalled();
  });

  it('calls notFound() when the API response is success=false', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'not_found', message: 'gone' },
    });

    await expect(
      EventSubscriptionDetailPage({ params: Promise.resolve({ id: 'wh_1' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(vi.mocked(notFound)).toHaveBeenCalled();
  });

  it('logs and calls notFound() when fetch throws', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('network down'));

    await expect(
      EventSubscriptionDetailPage({ params: Promise.resolve({ id: 'wh_1' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(vi.mocked(notFound)).toHaveBeenCalled();
  });
});
