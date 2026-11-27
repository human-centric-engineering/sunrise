// @vitest-environment happy-dom

/**
 * SignupPlanTakeUp (§139 t-1096): on the billing page a paid-plan signup goes
 * on to, it asks the route once to take up the plan the signup chose.
 * A checkout is followed to the provider; anything else reloads the page with
 * what happened in the query, and nothing waiting with no query at all.
 *
 * @see components/admin/billing/signup-plan-take-up.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => router,
}));

import { billingNavigation } from '@/components/admin/billing/billing-action-button';
import { SignupPlanTakeUp } from '@/components/admin/billing/signup-plan-take-up';
import { APIClientError, apiClient } from '@/lib/api/client';

const ORG = 'cmorg000000000000000other';

describe('SignupPlanTakeUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(billingNavigation, 'go').mockImplementation(() => {});
  });

  it('says it is opening payment, asks once, and follows the checkout', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      outcome: 'checkout',
      planKey: 'pro',
      url: 'https://checkout.stripe.test/c/1',
    });

    // StrictMode runs the effect twice in development: still one ask.
    render(
      <StrictMode>
        <SignupPlanTakeUp orgId={ORG} />
      </StrictMode>
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Taking you to the payment page for the plan you chose when you signed up…'
    );
    await waitFor(() =>
      expect(billingNavigation.go).toHaveBeenCalledWith('https://checkout.stripe.test/c/1')
    );
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith(`/api/v1/orgs/${ORG}/billing/signup-plan`);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each(['applied', 'dropped'])('reloads the page saying it was %s', async (outcome) => {
    vi.mocked(apiClient.post).mockResolvedValue({ outcome, planKey: 'starter' });

    render(<SignupPlanTakeUp orgId={ORG} />);

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(`/admin/billing?signup=${outcome}`)
    );
    expect(billingNavigation.go).not.toHaveBeenCalled();
  });

  it('reloads the page with no query when nothing was waiting', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ outcome: 'none' });

    render(<SignupPlanTakeUp orgId={ORG} />);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/billing'));
  });

  it('reloads the page saying it failed when the route refuses, or answers a URL that is not http(s)', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('not set up', 'CONFLICT', 409, { reason: 'price_missing' })
    );
    const { unmount } = render(<SignupPlanTakeUp orgId={ORG} />);
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith('/admin/billing?signup=failed')
    );
    unmount();

    vi.clearAllMocks();
    vi.mocked(apiClient.post).mockResolvedValue({
      outcome: 'checkout',
      url: 'javascript:alert(1)',
    });
    render(<SignupPlanTakeUp orgId={ORG} />);
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith('/admin/billing?signup=failed')
    );
    expect(billingNavigation.go).not.toHaveBeenCalled();
  });
});
