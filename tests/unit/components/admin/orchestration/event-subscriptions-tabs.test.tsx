/**
 * EventSubscriptionsTabs tests
 *
 * URL-synced tab wrapper around the Subscriptions list and DLQ table. The
 * children (WebhooksTable, WebhookDlqTable) are mocked so this file only
 * asserts the wrapper's own behaviour:
 *   - default tab = 'subscriptions' (URL has no `tab` param)
 *   - reading `?tab=dlq` activates the DLQ tab
 *   - clicking a tab fires the URL setter
 *   - badge counts come from the *Meta.total props, and hide at 0
 *
 * @see components/admin/orchestration/event-subscriptions-tabs.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the child tables — this file isn't testing their internals.
vi.mock('@/components/admin/orchestration/webhooks-table', () => ({
  WebhooksTable: () => <div data-testid="webhooks-table-mock" />,
}));
vi.mock('@/components/admin/orchestration/webhook-dlq-table', () => ({
  WebhookDlqTable: () => <div data-testid="webhook-dlq-table-mock" />,
}));

// useUrlTabs reads the URL via next/navigation. Stub it so each test can
// control the active tab and observe setActiveTab calls.
const setActiveTabMock = vi.fn();
let activeTabState: 'subscriptions' | 'dlq' = 'subscriptions';
vi.mock('@/lib/hooks/use-url-tabs', () => ({
  useUrlTabs: () => ({
    activeTab: activeTabState,
    setActiveTab: setActiveTabMock,
  }),
}));

import { EventSubscriptionsTabs } from '@/components/admin/orchestration/event-subscriptions-tabs';

const baseProps = {
  webhooks: [],
  webhooksMeta: { page: 1, limit: 25, total: 0, totalPages: 0 },
  dlqDeliveries: [],
  dlqMeta: { page: 1, limit: 25, total: 0, totalPages: 0 },
  dlqSubscriptions: [],
};

describe('EventSubscriptionsTabs', () => {
  it('renders Subscriptions tab content by default', () => {
    activeTabState = 'subscriptions';
    setActiveTabMock.mockClear();

    render(<EventSubscriptionsTabs {...baseProps} />);

    expect(screen.getByTestId('webhooks-table-mock')).toBeInTheDocument();
    // DLQ content body is not in the visible tab — but Radix renders both
    // panels in the DOM and uses aria-hidden / display to switch. The
    // mocked content is still mounted in the inactive panel, so don't
    // assert on visibility here.
    const subsTab = screen.getByRole('tab', { name: /subscriptions/i });
    expect(subsTab).toHaveAttribute('aria-selected', 'true');
  });

  it('renders DLQ tab content when activeTab is "dlq"', () => {
    activeTabState = 'dlq';
    setActiveTabMock.mockClear();

    render(<EventSubscriptionsTabs {...baseProps} />);

    const dlqTab = screen.getByRole('tab', { name: /dead letter queue/i });
    expect(dlqTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('webhook-dlq-table-mock')).toBeInTheDocument();
  });

  it('clicking the DLQ tab invokes setActiveTab("dlq")', async () => {
    activeTabState = 'subscriptions';
    setActiveTabMock.mockClear();

    const user = userEvent.setup();
    render(<EventSubscriptionsTabs {...baseProps} />);

    await user.click(screen.getByRole('tab', { name: /dead letter queue/i }));

    expect(setActiveTabMock).toHaveBeenCalledWith('dlq');
  });

  it('shows the subscriptions count badge when total > 0', () => {
    activeTabState = 'subscriptions';
    setActiveTabMock.mockClear();

    render(
      <EventSubscriptionsTabs
        {...baseProps}
        webhooksMeta={{ page: 1, limit: 25, total: 7, totalPages: 1 }}
      />
    );

    const subsTab = screen.getByRole('tab', { name: /subscriptions/i });
    expect(subsTab).toHaveTextContent('7');
  });

  it('hides the subscriptions count badge when total is 0', () => {
    activeTabState = 'subscriptions';
    setActiveTabMock.mockClear();

    render(<EventSubscriptionsTabs {...baseProps} />);

    const subsTab = screen.getByRole('tab', { name: /subscriptions/i });
    // No badge content — the tab label is just "Subscriptions".
    expect(subsTab.textContent?.trim()).toBe('Subscriptions');
  });

  it('shows the DLQ count badge when dlqMeta.total > 0', () => {
    activeTabState = 'subscriptions';
    setActiveTabMock.mockClear();

    render(
      <EventSubscriptionsTabs
        {...baseProps}
        dlqMeta={{ page: 1, limit: 25, total: 3, totalPages: 1 }}
      />
    );

    const dlqTab = screen.getByRole('tab', { name: /dead letter queue/i });
    expect(dlqTab).toHaveTextContent('3');
  });
});
