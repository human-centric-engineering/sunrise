// @vitest-environment happy-dom

/**
 * Admin — Billing page (§139 t-1095).
 *
 * The page is a thin shell over `GET /api/v1/orgs/[id]/billing`, so what is
 * under test is what it chooses to show: nothing at all with billing off
 * (the page does not exist), a plain explanation in the install org and with
 * no org (fetching nothing), the summary for the org it acts in, the
 * checkout return notices, and an alert, logged, when billing cannot be
 * loaded. Only `serverFetch` is faked: the real parser and `loadServerData`
 * run. Who is turned away is the layout's and the route's: see
 * `tests/unit/lib/auth/admin-tier.test.ts` (a MEMBER reaches no org-tier
 * page) and the route's test.
 *
 * @see app/admin/billing/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/admin-page-viewer', () => ({ requestActingOrg: vi.fn() }));

vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

const billing = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/billing/config', () => ({ billingEnabled: () => billing.on }));

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  })
);
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound,
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const summaryProps = vi.fn();
vi.mock('@/components/admin/billing/billing-summary', () => ({
  BillingSummary: (props: unknown) => {
    summaryProps(props);
    return <div data-testid="billing-summary" />;
  },
}));

// The take-up's own behaviour is signup-plan-take-up.test.tsx; here, when the
// page renders it (§139 t-1096).
vi.mock('@/components/admin/billing/signup-plan-take-up', () => ({
  SignupPlanTakeUp: ({ orgId }: { orgId: string }) => (
    <div data-testid="signup-plan-take-up">{orgId}</div>
  ),
}));
vi.mock('@/components/admin/billing/signup-plan-notice', () => ({
  SignupPlanNotice: ({ orgId, planLabel }: { orgId: string; planLabel: string }) => (
    <div data-testid="signup-plan-notice">
      {orgId}:{planLabel}
    </div>
  ),
}));

import BillingPage from '@/app/admin/billing/page';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const ORG = { id: 'org-entered', name: 'Acme' };
const BILLING = { orgId: ORG.id, plan: null, mayChange: true, signupPlan: null };
/** The org's signup chose Pro, and it has not subscribed yet. */
const WAITING = { ...BILLING, signupPlan: { key: 'pro', label: 'Pro' } };

const page = (query: Record<string, string> = {}) =>
  BillingPage({ searchParams: Promise.resolve(query) });

describe('BillingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    billing.on = true;
    vi.mocked(requestActingOrg).mockResolvedValue(ORG);
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(BILLING));
  });

  it('shows the billing of the org it acts in, read through the API', async () => {
    render(await page());

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe('/api/v1/orgs/org-entered/billing');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Billing for Acme');
    expect(summaryProps).toHaveBeenCalledWith({ billing: BILLING });
  });

  it('does not exist while billing is off, and fetches nothing', async () => {
    billing.on = false;

    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(serverFetch).not.toHaveBeenCalled();
  });

  it('explains, and fetches nothing, in the install org', async () => {
    vi.mocked(requestActingOrg).mockResolvedValue({ id: INSTALL_ORG_ID, name: 'Default' });

    render(await page());

    expect(screen.getByText(/never billed/)).toBeInTheDocument();
    expect(serverFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('billing-summary')).not.toBeInTheDocument();
  });

  it('explains, and fetches nothing, when acting in no org', async () => {
    vi.mocked(requestActingOrg).mockResolvedValue(null);

    render(await page());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Billing');
    expect(screen.getByText(/not acting in an organisation/)).toBeInTheDocument();
    expect(serverFetch).not.toHaveBeenCalled();
  });

  it('says so, and logs, when billing cannot be loaded, rather than show no plan', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    render(await page());

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByTestId('billing-summary')).not.toBeInTheDocument();
    expect(logger.error).toHaveBeenCalled();
  });

  it('says a refusal is one, rather than telling the viewer to reload', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(403, 'FORBIDDEN'));

    render(await page());

    expect(
      screen.getByText(/do not have access to this organisation's billing/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reload the page/)).not.toBeInTheDocument();
  });

  it('says billing could not be loaded, and logs, when the acting org cannot be read', async () => {
    vi.mocked(requestActingOrg).mockRejectedValue(new Error('connection refused'));

    render(await page());

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(serverFetch).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'billing page: could not read the acting org',
      expect.any(Error)
    );
  });

  it('thanks the owner back from a paid checkout, and says the plan follows', async () => {
    render(await page({ checkout: 'success' }));

    expect(screen.getByRole('status')).toHaveTextContent('Your payment went through');
    // A plain reload would keep the query, and this note with it.
    expect(screen.getByRole('link', { name: 'See the updated plan' })).toHaveAttribute(
      'href',
      '/admin/billing'
    );
    expect(screen.getByTestId('billing-summary')).toBeInTheDocument();
  });

  it('says nothing was charged after a cancelled checkout', async () => {
    render(await page({ checkout: 'cancelled' }));

    expect(screen.getByRole('status')).toHaveTextContent('nothing was charged');
  });

  it('shows no notice for any other value', async () => {
    render(await page({ checkout: 'whatever' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('BillingPage — a plan chosen at signup (§139 t-1096)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    billing.on = true;
    vi.mocked(requestActingOrg).mockResolvedValue(ORG);
  });

  it('starts the waiting plan’s checkout for the owner the signup sent here', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(WAITING));

    render(await page({ signup: 'plan' }));

    expect(screen.getByTestId('signup-plan-take-up')).toHaveTextContent(ORG.id);
    expect(screen.queryByTestId('signup-plan-notice')).not.toBeInTheDocument();
  });

  it('does not for a viewer who cannot pay, nor with no paid plan waiting', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess({ ...WAITING, mayChange: false }));
    const { unmount } = render(await page({ signup: 'plan' }));
    expect(screen.queryByTestId('signup-plan-take-up')).not.toBeInTheDocument();
    expect(screen.queryByTestId('signup-plan-notice')).not.toBeInTheDocument();
    unmount();

    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(BILLING));
    render(await page({ signup: 'plan' }));
    expect(screen.queryByTestId('signup-plan-take-up')).not.toBeInTheDocument();
  });

  it('offers the waiting plan to the owner on any other visit, until it is settled', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(WAITING));

    render(await page());

    expect(screen.getByTestId('signup-plan-notice')).toHaveTextContent(`${ORG.id}:Pro`);
    expect(screen.queryByTestId('signup-plan-take-up')).not.toBeInTheDocument();
  });

  it('offers it again beside a failed checkout', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(WAITING));

    render(await page({ signup: 'failed' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The payment page for the plan you chose could not be opened. Try again below.'
    );
    expect(screen.getByTestId('signup-plan-notice')).toBeInTheDocument();
  });

  it.each([
    ['applied', 'This organisation is now on the plan you chose when you signed up.', 'status'],
    [
      'dropped',
      'The plan you chose when you signed up is no longer offered. Choose one below.',
      'status',
    ],
    [
      'failed',
      'The payment page for the plan you chose could not be opened. Try again below.',
      'alert',
    ],
  ])('says what happened when it comes back with ?signup=%s', async (outcome, words, role) => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(BILLING));

    render(await page({ signup: outcome }));

    expect(screen.getByRole(role)).toHaveTextContent(words);
    expect(screen.queryByTestId('signup-plan-take-up')).not.toBeInTheDocument();
  });
});
