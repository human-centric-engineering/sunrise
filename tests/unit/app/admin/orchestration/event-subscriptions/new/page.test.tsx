// @vitest-environment happy-dom

/**
 * Unit Test: New event subscription page
 *
 * @see app/admin/orchestration/event-subscriptions/new/page.tsx
 *
 * Simple server component — renders breadcrumb + WebhookForm in
 * `mode: 'create'`. No data fetching.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/admin/orchestration/webhook-form', () => ({
  WebhookForm: ({ mode }: { mode: string; webhook?: unknown }) => (
    <div data-testid="webhook-form" data-mode={mode} />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import React from 'react';
import NewEventSubscriptionPage, {
  metadata,
} from '@/app/admin/orchestration/event-subscriptions/new/page';

describe('NewEventSubscriptionPage', () => {
  it('exports metadata with the new-subscription title', () => {
    expect(metadata.title).toBe('New Event Subscription · AI Orchestration');
  });

  it('renders the WebhookForm in create mode', () => {
    render(NewEventSubscriptionPage());

    const form = screen.getByTestId('webhook-form');
    expect(form.getAttribute('data-mode')).toBe('create');
  });

  it('renders breadcrumb linking back to the list', () => {
    render(NewEventSubscriptionPage());

    const link = screen.getByRole('link', { name: 'Event Subscriptions' });
    expect(link).toHaveAttribute('href', '/admin/orchestration/event-subscriptions');
  });
});
