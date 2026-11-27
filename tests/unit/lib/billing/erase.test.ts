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

import { BillingErasureError, cancelOrgSubscriptionsAtProvider } from '@/lib/billing/erase';

const ORG = 'org_a';
const provider = {
  key: 'stripe',
  findCustomerRefs: vi.fn(),
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
  it('cancels every live subscription of every customer, the stored one and the ones searched', async () => {
    const result = await cancelOrgSubscriptionsAtProvider(ORG);

    expect(provider.findCustomerRefs).toHaveBeenCalledWith(ORG);
    expect(result).toEqual({
      provider: 'stripe',
      customers: ['cus_a', 'cus_orphan'],
      cancelled: ['sub_1', 'sub_unpaid', 'sub_never_stored'],
    });
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(3);
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
