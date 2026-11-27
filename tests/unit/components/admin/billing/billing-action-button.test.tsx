// @vitest-environment happy-dom

/**
 * The billing page's checkout and portal buttons (§139 t-1095).
 *
 * Pinned: each asks its route for a URL and sends the browser there; a
 * refusal shows beside the button in the route's words, and the button can
 * be pressed again; an answer that is not a web address (a `javascript:`
 * URL, say) is never followed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import {
  BillingActionButton,
  billingNavigation,
} from '@/components/admin/billing/billing-action-button';
import { APIClientError, apiClient } from '@/lib/api/client';

const ORG = 'cmorg000000000000000other';

/** A `pageshow`; happy-dom's `PageTransitionEvent` does not carry `persisted` from its init. */
function pageshow(persisted: boolean): Event {
  return Object.assign(new Event('pageshow'), { persisted });
}

describe('BillingActionButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(billingNavigation, 'go').mockImplementation(() => {});
  });

  it('starts a checkout for its plan and goes to the provider’s page', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ url: 'https://checkout.stripe.test/c/1' });
    render(<BillingActionButton orgId={ORG} kind="checkout" planKey="team" label="Choose Team" />);

    await userEvent.click(screen.getByRole('button', { name: 'Choose Team' }));

    expect(apiClient.post).toHaveBeenCalledWith(`/api/v1/orgs/${ORG}/billing/checkout`, {
      body: { planKey: 'team' },
    });
    await waitFor(() =>
      expect(billingNavigation.go).toHaveBeenCalledWith('https://checkout.stripe.test/c/1')
    );
    // Left disabled while the page goes away.
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('can be pressed again when Back restores the page from the back-forward cache', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ url: 'https://checkout.stripe.test/c/1' });
    render(<BillingActionButton orgId={ORG} kind="checkout" planKey="team" label="Choose Team" />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Team' }));
    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());

    // A page loaded afresh changes nothing; one restored as it was is re-enabled.
    act(() => {
      window.dispatchEvent(pageshow(false));
    });
    expect(screen.getByRole('button')).toBeDisabled();
    act(() => {
      window.dispatchEvent(pageshow(true));
    });
    expect(screen.getByRole('button', { name: 'Choose Team' })).toBeEnabled();
  });

  it('opens the portal', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ url: 'https://billing.stripe.test/p/1' });
    render(<BillingActionButton orgId={ORG} kind="portal" label="Manage billing" />);

    await userEvent.click(screen.getByRole('button', { name: 'Manage billing' }));

    expect(apiClient.post).toHaveBeenCalledWith(`/api/v1/orgs/${ORG}/billing/portal`);
    await waitFor(() =>
      expect(billingNavigation.go).toHaveBeenCalledWith('https://billing.stripe.test/p/1')
    );
  });

  it('shows a refusal in the route’s words, and can be pressed again', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError(
        'This organisation already has a subscription. Change plan in the billing portal.',
        'CONFLICT',
        409,
        { reason: 'already_subscribed' }
      )
    );
    render(<BillingActionButton orgId={ORG} kind="checkout" planKey="team" label="Choose Team" />);

    await userEvent.click(screen.getByRole('button', { name: 'Choose Team' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already has a subscription');
    expect(billingNavigation.go).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Choose Team' })).toBeEnabled();
  });

  it('never follows an answer that is not a web address', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ url: 'javascript:alert(1)' });
    render(<BillingActionButton orgId={ORG} kind="portal" label="Manage billing" />);

    await userEvent.click(screen.getByRole('button', { name: 'Manage billing' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The billing portal could not be opened.'
    );
    expect(billingNavigation.go).not.toHaveBeenCalled();
  });
});

describe('billingNavigation', () => {
  it('sends the browser to the address', () => {
    vi.restoreAllMocks();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      billingNavigation.go('https://billing.stripe.test/p/1');
      expect(assign).toHaveBeenCalledWith('https://billing.stripe.test/p/1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
