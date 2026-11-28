/**
 * Unit Tests: cancelling an org's subscriptions before it is erased (§139 t-1094)
 *
 * Every customer is found (the stored one and any the provider's search
 * names), every live subscription of each is cancelled, and erasure is
 * refused while the org may still be paying at a provider that is not on.
 * That `eraseOrg()` calls this before deleting anything is
 * `tests/unit/lib/privacy/erase-org.test.ts`.
 *
 * @see lib/billing/erase.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const record = vi.hoisted((): { row: unknown } => ({ row: null }));
vi.mock('@/lib/db/client', () => ({
  prisma: { orgBillingSubscription: { findUnique: vi.fn(async () => record.row) } },
}));

const fake = vi.hoisted((): { provider: unknown } => ({ provider: null }));
vi.mock('@/lib/billing/config', () => ({ billingProvider: async () => fake.provider }));

// What reporting writes and sends is usage-report.test.ts; here, that it
// comes before any cancellation and that its failure stops the erasure.
const mockReportBeforeCancelling = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('@/lib/billing/usage-report', () => ({
  reportBeforeCancelling: mockReportBeforeCancelling,
}));

import { BillingErasureError, cancelOrgSubscriptionsAtProvider } from '@/lib/billing/erase';
import { logger } from '@/lib/logging';

const ORG = 'org_a';
const provider = {
  key: 'stripe',
  findCustomerRefs: vi.fn(),
  expireOpenCheckouts: vi.fn(),
  listLiveSubscriptions: vi.fn(),
  cancelSubscription: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  fake.provider = provider;
  record.row = {
    provider: 'stripe',
    customerRef: 'cus_a',
    subscriptionRef: 'sub_1',
    status: 'ACTIVE',
  };
  provider.findCustomerRefs.mockResolvedValue(['cus_a', 'cus_orphan']);
  provider.listLiveSubscriptions.mockImplementation(async (customerRef: string) =>
    customerRef === 'cus_a'
      ? [{ ref: 'sub_1' }, { ref: 'sub_unpaid' }]
      : [{ ref: 'sub_never_stored' }]
  );
  provider.cancelSubscription.mockResolvedValue(undefined);
});

describe('cancelOrgSubscriptionsAtProvider', () => {
  it('reports the open period’s usage before it cancels anything (t-1097)', async () => {
    mockReportBeforeCancelling.mockResolvedValueOnce(2);

    await cancelOrgSubscriptionsAtProvider(ORG);

    expect(mockReportBeforeCancelling).toHaveBeenCalledWith(provider, ORG);
    expect(mockReportBeforeCancelling.mock.invocationCallOrder[0]).toBeLessThan(
      provider.cancelSubscription.mock.invocationCallOrder[0]
    );
  });

  it('cancels anyway when the usage report fails, and logs what went unbilled', async () => {
    // A meter that cannot count, or a provider meter that refuses, must not
    // hold up erasing the org's data for good.
    mockReportBeforeCancelling.mockRejectedValueOnce(new Error('count broke'));

    const result = await cancelOrgSubscriptionsAtProvider(ORG);

    expect(result?.cancelled).toEqual(['sub_1', 'sub_unpaid', 'sub_never_stored']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not report'),
      expect.objectContaining({ orgId: ORG, error: 'count broke' })
    );
  });

  it('reports nothing while billing is off', async () => {
    fake.provider = null;
    record.row = null;

    await cancelOrgSubscriptionsAtProvider(ORG);

    expect(mockReportBeforeCancelling).not.toHaveBeenCalled();
  });

  it('cancels every live subscription of every customer, the stored one and the ones searched', async () => {
    const result = await cancelOrgSubscriptionsAtProvider(ORG);

    expect(provider.findCustomerRefs).toHaveBeenCalledWith(ORG);
    expect(result).toEqual({
      provider: 'stripe',
      customers: ['cus_a', 'cus_orphan'],
      cancelled: ['sub_1', 'sub_unpaid', 'sub_never_stored'],
    });
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(3);
    // Each customer's open checkout pages are closed before its subscriptions.
    expect(provider.expireOpenCheckouts.mock.calls).toEqual([['cus_a'], ['cus_orphan']]);
    expect(provider.expireOpenCheckouts.mock.invocationCallOrder[0]).toBeLessThan(
      provider.listLiveSubscriptions.mock.invocationCallOrder[0]
    );
  });

  it('finds a customer by search when none was ever stored', async () => {
    record.row = null;
    provider.findCustomerRefs.mockResolvedValue(['cus_orphan']);

    const result = await cancelOrgSubscriptionsAtProvider(ORG);

    expect(result?.cancelled).toEqual(['sub_never_stored']);
  });

  it('stops at the first refusal, so the erasure stops and can be retried', async () => {
    provider.cancelSubscription.mockRejectedValueOnce(new Error('card_declined'));
    await expect(cancelOrgSubscriptionsAtProvider(ORG)).rejects.toThrow('card_declined');
  });

  it('refuses while billing is off and the org holds a subscription that has not ended', async () => {
    fake.provider = null;
    const error = await cancelOrgSubscriptionsAtProvider(ORG).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingErasureError);
    expect(error).toMatchObject({ status: 409, code: 'BILLING_NOT_CANCELLED' });
  });

  it('refuses while billing is off and the org’s ended subscription can still be charged', async () => {
    fake.provider = null;
    record.row = {
      provider: 'stripe',
      customerRef: 'cus_a',
      subscriptionRef: 'sub_1',
      status: 'ENDED',
      providerLive: true,
    };
    await expect(cancelOrgSubscriptionsAtProvider(ORG)).rejects.toBeInstanceOf(BillingErasureError);
  });

  it('refuses the same when the subscription is at a provider other than the one on', async () => {
    record.row = {
      provider: 'paddle',
      customerRef: 'ctm_1',
      subscriptionRef: 'sub_p',
      status: 'PAST_DUE',
    };
    await expect(cancelOrgSubscriptionsAtProvider(ORG)).rejects.toBeInstanceOf(BillingErasureError);
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['no record', null],
    [
      'a hand-assigned plan',
      { provider: null, customerRef: null, subscriptionRef: null, status: 'ACTIVE' },
    ],
    [
      'an ended subscription',
      { provider: 'stripe', customerRef: 'cus_a', subscriptionRef: 'sub_1', status: 'ENDED' },
    ],
  ])('lets erasure go ahead with billing off and %s', async (_name, row) => {
    fake.provider = null;
    record.row = row;
    await expect(cancelOrgSubscriptionsAtProvider(ORG)).resolves.toBeNull();
  });
});
