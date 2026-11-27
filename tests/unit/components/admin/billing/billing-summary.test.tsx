// @vitest-environment happy-dom

/**
 * The billing page's content (§139 t-1095).
 *
 * Pinned: the OWNER (`mayChange`) gets a checkout button for each plan they
 * are not on and the portal button; an ADMIN sees the same plan, status,
 * period, usage and plans with no button at all, and is told only an owner
 * can change it. A live subscription changes plan in the portal, so no
 * checkout is offered over one. Usage that could not be counted says so,
 * never "0". The button itself is faked: its own test covers it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const buttons = vi.fn();
vi.mock('@/components/admin/billing/billing-action-button', () => ({
  BillingActionButton: (props: { label: string }) => {
    buttons(props);
    return <button type="button">{props.label}</button>;
  },
}));

import { BillingSummary, type OrgBillingView } from '@/components/admin/billing/billing-summary';

const ORG = 'cmorg000000000000000other';

function billing(overrides: Partial<OrgBillingView> = {}): OrgBillingView {
  return {
    orgId: ORG,
    plan: { key: 'pro', label: 'Pro', description: 'More of everything' },
    subscription: {
      status: 'ACTIVE',
      providerManaged: true,
      elsewhere: false,
      assignedByHand: false,
      cancelAtPeriodEnd: false,
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: '2026-12-01T00:00:00.000Z',
    },
    usage: [
      {
        key: 'seats',
        label: 'Seats',
        description: '',
        period: 'standing',
        limit: 10,
        used: 3,
        countFailed: false,
      },
      {
        key: 'runs',
        label: 'Workflow runs',
        description: '',
        period: 'month',
        limit: null,
        used: 1200,
        countFailed: false,
      },
    ],
    plans: [
      { key: 'pro', label: 'Pro', description: 'More of everything', current: true },
      { key: 'team', label: 'Team', description: 'For bigger teams', current: false },
    ],
    mayChange: true,
    portalAvailable: true,
    installOrg: false,
    ...overrides,
  };
}

describe('BillingSummary', () => {
  it('shows the plan, its status and period, and usage against each limit', () => {
    render(<BillingSummary billing={billing()} />);

    expect(screen.getAllByText('Pro').length).toBeGreaterThan(0);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('November 1, 2026 to December 1, 2026')).toBeInTheDocument();
    const seats = screen.getByRole('row', { name: /Seats/ });
    expect(within(seats).getByText('3')).toBeInTheDocument();
    expect(within(seats).getByText('10')).toBeInTheDocument();
    const runs = screen.getByRole('row', { name: /Workflow runs/ });
    expect(within(runs).getByText('1,200')).toBeInTheDocument();
    expect(within(runs).getByText('No limit')).toBeInTheDocument();
    expect(within(runs).getByText('This month')).toBeInTheDocument();
  });

  describe('for the OWNER', () => {
    it('offers the portal, and sends a live subscription there to change plan', () => {
      buttons.mockClear();
      render(<BillingSummary billing={billing()} />);

      expect(screen.getByRole('button', { name: 'Manage billing' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Choose/ })).not.toBeInTheDocument();
      expect(screen.getByText(/To move to another plan, open Manage billing/)).toBeInTheDocument();
      expect(screen.queryByText(/Only an owner/)).not.toBeInTheDocument();
      expect(buttons).toHaveBeenCalledWith({
        orgId: ORG,
        kind: 'portal',
        label: 'Manage billing',
      });
    });

    it('offers a checkout for each plan it is not on, with no live subscription', () => {
      buttons.mockClear();
      render(
        <BillingSummary
          billing={billing({
            plan: null,
            subscription: null,
            portalAvailable: false,
            plans: [
              { key: 'pro', label: 'Pro', description: '', current: false },
              { key: 'team', label: 'Team', description: '', current: false },
            ],
          })}
        />
      );

      expect(screen.getByText('This organisation is not on a plan.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose Pro' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose Team' })).toBeInTheDocument();
      expect(buttons).toHaveBeenCalledWith({
        orgId: ORG,
        kind: 'checkout',
        planKey: 'team',
        label: 'Choose Team',
      });
      // Nothing bought yet, so nothing to manage.
      expect(screen.queryByRole('button', { name: 'Manage billing' })).not.toBeInTheDocument();
      expect(screen.getByText(/nothing to manage until/)).toBeInTheDocument();
    });

    it('offers no checkout for the plan it is on', () => {
      render(
        <BillingSummary
          billing={billing({
            subscription: { ...billing().subscription!, providerManaged: false, status: 'ENDED' },
          })}
        />
      );

      expect(screen.queryByRole('button', { name: 'Choose Pro' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose Team' })).toBeInTheDocument();
    });

    it('offers a checkout again while the first payment is still waiting', () => {
      render(
        <BillingSummary
          billing={billing({ subscription: { ...billing().subscription!, status: 'INCOMPLETE' } })}
        />
      );

      expect(screen.getByText('Waiting for the first payment')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose Team' })).toBeInTheDocument();
      expect(screen.queryByText(/To move to another plan/)).not.toBeInTheDocument();
    });

    it('says a subscription at another provider has to end there, with nothing to press', () => {
      render(
        <BillingSummary
          billing={billing({
            subscription: { ...billing().subscription!, elsewhere: true },
            portalAvailable: false,
          })}
        />
      );

      expect(screen.queryAllByRole('button')).toEqual([]);
      expect(
        screen.getByText(/It has to end there before a plan can be bought here/)
      ).toBeInTheDocument();
      expect(screen.getByText(/so it cannot be managed here/)).toBeInTheDocument();
      expect(screen.queryByText(/To move to another plan/)).not.toBeInTheDocument();
      expect(screen.queryByText(/nothing to manage until/)).not.toBeInTheDocument();
    });
  });

  describe('for an ADMIN', () => {
    it('shows the same page read-only, and says only an owner can change it', () => {
      render(
        <BillingSummary
          billing={billing({
            mayChange: false,
            subscription: { ...billing().subscription!, providerManaged: false },
          })}
        />
      );

      expect(screen.getByText(/Only an owner of this organisation/)).toBeInTheDocument();
      expect(screen.queryAllByRole('button')).toEqual([]);
      expect(screen.queryByText('Payments and invoices')).not.toBeInTheDocument();
      expect(screen.getByText('Team')).toBeInTheDocument();
      expect(screen.getByRole('row', { name: /Seats/ })).toBeInTheDocument();
    });

    it('tells them an owner changes the card when a payment failed, not to press a button', () => {
      render(
        <BillingSummary
          billing={billing({
            mayChange: false,
            subscription: { ...billing().subscription!, status: 'PAST_DUE' },
          })}
        />
      );

      expect(
        screen.getByText(/An owner of this organisation can change the card/)
      ).toBeInTheDocument();
      expect(screen.queryByText(/open Manage billing/)).not.toBeInTheDocument();
    });
  });

  it('says a plan staff set is not paid for here', () => {
    render(
      <BillingSummary
        billing={billing({
          subscription: {
            status: 'ACTIVE',
            providerManaged: false,
            elsewhere: false,
            assignedByHand: true,
            cancelAtPeriodEnd: false,
            periodStart: null,
            periodEnd: null,
          },
          portalAvailable: false,
        })}
      />
    );

    expect(screen.getByText(/Set by platform staff/)).toBeInTheDocument();
    expect(screen.queryByText(/Current period/)).not.toBeInTheDocument();
  });

  it('explains a failed payment, and a subscription that will not renew', () => {
    render(
      <BillingSummary
        billing={billing({
          subscription: { ...billing().subscription!, status: 'PAST_DUE', cancelAtPeriodEnd: true },
        })}
      />
    );

    expect(screen.getByText('Payment overdue')).toBeInTheDocument();
    expect(screen.getByText(/you keep your plan in the meantime/)).toBeInTheDocument();
    expect(screen.getByText('Ends on December 1, 2026. It will not renew.')).toBeInTheDocument();
  });

  it('shows no current period once the subscription has ended', () => {
    render(
      <BillingSummary
        billing={billing({ subscription: { ...billing().subscription!, status: 'ENDED' } })}
      />
    );

    expect(screen.getByText('Ended')).toBeInTheDocument();
    expect(screen.getByText('The paid subscription has ended.')).toBeInTheDocument();
    expect(screen.queryByText(/Current period/)).not.toBeInTheDocument();
  });

  it('says nothing about ending on a date once a cancelled subscription has ended', () => {
    render(
      <BillingSummary
        billing={billing({
          subscription: { ...billing().subscription!, status: 'ENDED', cancelAtPeriodEnd: true },
        })}
      />
    );

    expect(screen.getByText('Ended')).toBeInTheDocument();
    expect(screen.queryByText(/Ends on/)).not.toBeInTheDocument();
  });

  it('names a plan the app no longer offers by its key', () => {
    render(
      <BillingSummary
        billing={billing({ plan: { key: 'legacy', label: null, description: '' } })}
      />
    );

    expect(screen.getByText('A plan this app no longer offers (legacy)')).toBeInTheDocument();
  });

  it('says usage could not be counted, never zero', () => {
    render(
      <BillingSummary
        billing={billing({
          usage: [
            {
              key: 'seats',
              label: 'Seats',
              description: '',
              period: 'standing',
              limit: 10,
              used: null,
              countFailed: true,
            },
          ],
        })}
      />
    );

    expect(
      within(screen.getByRole('row', { name: /Seats/ })).getByText('Could not be counted')
    ).toBeInTheDocument();
  });

  it('says so when usage could not be read at all, and when nothing is counted', () => {
    const { rerender } = render(<BillingSummary billing={billing({ usage: null })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Usage could not be counted');

    rerender(<BillingSummary billing={billing({ usage: [] })} />);
    expect(screen.getByText('Nothing is counted on this install.')).toBeInTheDocument();
  });

  it('says there is nothing to buy when no plan has a price', () => {
    render(<BillingSummary billing={billing({ plans: [] })} />);

    expect(screen.getByText(/There are no plans to buy here/)).toBeInTheDocument();
  });
});
