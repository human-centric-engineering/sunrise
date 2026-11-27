// @vitest-environment happy-dom

/**
 * SignupPlanNotice (§139 t-1096): the paid plan a signup chose, still waiting,
 * offered on the billing page. Continuing asks the route for its checkout and
 * follows it; choosing another removes it and refreshes the page. A failure
 * shows beside the buttons, and they are usable again.
 *
 * @see components/admin/billing/signup-plan-notice.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
import { SignupPlanNotice } from '@/components/admin/billing/signup-plan-notice';
import { APIClientError, apiClient } from '@/lib/api/client';

const ORG = 'cmorg000000000000000other';
const ROUTE = `/api/v1/orgs/${ORG}/billing/signup-plan`;

describe('SignupPlanNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(billingNavigation, 'go').mockImplementation(() => {});
  });

  it('names the plan the signup chose', () => {
    render(<SignupPlanNotice orgId={ORG} planLabel="Pro" />);

    expect(
      screen.getByText(
        'You chose the Pro plan when you signed up, but have not subscribed to it yet.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe to Pro' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Choose a different plan' })).toBeEnabled();
  });

  it('continues to the checkout the route answers', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      outcome: 'checkout',
      planKey: 'pro',
      url: 'https://checkout.stripe.test/c/2',
    });
    render(<SignupPlanNotice orgId={ORG} planLabel="Pro" />);

    await userEvent.click(screen.getByRole('button', { name: 'Subscribe to Pro' }));

    expect(apiClient.post).toHaveBeenCalledWith(ROUTE);
    await waitFor(() =>
      expect(billingNavigation.go).toHaveBeenCalledWith('https://checkout.stripe.test/c/2')
    );
    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
  });

  it('reloads the page when there was nothing left to start', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ outcome: 'none' });
    render(<SignupPlanNotice orgId={ORG} planLabel="Pro" />);

    await userEvent.click(screen.getByRole('button', { name: 'Subscribe to Pro' }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/billing'));
    expect(billingNavigation.go).not.toHaveBeenCalled();
  });

  it.each(['applied', 'dropped'])(
    'reloads the page saying what happened when the route answers %s',
    async (outcome) => {
      vi.mocked(apiClient.post).mockResolvedValue({ outcome, planKey: 'pro' });
      render(<SignupPlanNotice orgId={ORG} planLabel="Pro" />);

      await userEvent.click(screen.getByRole('button', { name: 'Subscribe to Pro' }));

      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith(`/admin/billing?signup=${outcome}`)
      );
    }
  );

  it('does not follow a checkout URL that is not http(s)', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      outcome: 'checkout',
      planKey: 'pro',
      url: 'javascript:alert(1)',
    });
    render(<SignupPlanNotice orgId={ORG} planLabel="Pro" />);

    await userEvent.click(screen.getByRole('button', { name: 'Subscribe to Pro' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Subscribe to Pro' })).toBeEnabled()
    );
    expect(billingNavigation.go).not.toHaveBeenCalled();
  });

  it('shows a refused checkout beside the buttons, in the route’s words, and lets them try again', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('The price for this plan is not set up yet', 'CONFLICT', 409)
    );
    render(<SignupPlanNotice orgId={ORG} planLabel="Pro" />);

    await userEvent.click(screen.getByRole('button', { name: 'Subscribe to Pro' }));

    expect(
      await screen.findByText('The price for this plan is not set up yet')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe to Pro' })).toBeEnabled();
  });

  it('removes the plan and refreshes when the owner chooses another', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ removed: 'pro' });
    render(<SignupPlanNotice orgId={ORG} planLabel="Pro" />);

    await userEvent.click(screen.getByRole('button', { name: 'Choose a different plan' }));

    expect(apiClient.delete).toHaveBeenCalledWith(ROUTE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('shows a failed removal beside the buttons', async () => {
    vi.mocked(apiClient.delete).mockRejectedValue(new Error('network down'));
    render(<SignupPlanNotice orgId={ORG} planLabel="Pro" />);

    await userEvent.click(screen.getByRole('button', { name: 'Choose a different plan' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
