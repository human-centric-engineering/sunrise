/**
 * Unit Tests: checkout and the portal (§139 t-1094)
 *
 * The real `startCheckout()` and `openBillingPortal()` over an in-memory
 * subscription record and a fake provider. Pins the "one subscription per
 * org" rule (a live one is refused; an incomplete or paused one is cancelled
 * first; an ended one is not), that the customer is created once and stored,
 * the refusals, and where the provider sends the owner back to.
 *
 * @see lib/billing/checkout.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi', BETTER_AUTH_URL: 'https://app.test/' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const plans = vi.hoisted(() => ({
  free: { key: 'free', label: 'Free', priceLookupKey: null },
  pro: { key: 'pro', label: 'Pro', priceLookupKey: 'pro_monthly' },
}));
vi.mock('@/lib/billing/plans', () => ({
  planOf: (key: string) => (plans as Record<string, unknown>)[key],
}));

interface Row {
  provider: string | null;
  customerRef: string | null;
  subscriptionRef: string | null;
}
const db = vi.hoisted(() => ({ orgs: new Set<string>(), records: new Map<string, Row>() }));
const mockPrisma = vi.hoisted(() => {
  const client = {
    org: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        db.orgs.has(where.id) ? { name: 'Acme' } : null
      ),
    },
    orgBillingSubscription: {
      findUnique: vi.fn(async ({ where }: { where: { orgId: string } }) => {
        const row = db.records.get(where.orgId);
        return row ? { ...row } : null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { orgId: string };
          create: Partial<Row>;
          update: Partial<Row>;
        }) => {
          const existing = db.records.get(where.orgId);
          const row = existing
            ? { ...existing, ...update }
            : { provider: null, customerRef: null, subscriptionRef: null, ...create };
          db.records.set(where.orgId, row);
          return row;
        }
      ),
    },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, orgId: string) =>
      db.orgs.has(orgId) ? [{ id: orgId }] : []
    ),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };
  return client;
});
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import { BillingPriceMissingError, type ProviderSubscription } from '@/lib/billing/provider';

const fake = vi.hoisted((): { provider: unknown } => ({ provider: null }));
vi.mock('@/lib/billing/config', () => ({ billingProvider: async () => fake.provider }));

import { BillingCheckoutError, openBillingPortal, startCheckout } from '@/lib/billing/checkout';

const ORG = 'org_a';

function sub(overrides: Partial<ProviderSubscription>): ProviderSubscription {
  return {
    ref: 'sub_1',
    customerRef: 'cus_a',
    status: 'active',
    providerStatus: 'active',
    priceLookupKeys: ['pro_monthly'],
    periodStart: new Date(),
    periodEnd: new Date(),
    cancelAtPeriodEnd: false,
    endedAt: null,
    live: true,
    orgId: ORG,
    ...overrides,
  };
}

const provider = {
  key: 'stripe',
  createCheckout: vi.fn(),
  openPortal: vi.fn(),
  fetchSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
};

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BillingCheckoutError);
  return (error as BillingCheckoutError).code;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.orgs = new Set([ORG]);
  db.records = new Map();
  fake.provider = provider;
  provider.createCheckout.mockImplementation(async (input: { customerRef: string | null }) => ({
    url: 'https://checkout.test/s',
    customerRef: input.customerRef ?? 'cus_created',
  }));
  provider.openPortal.mockResolvedValue({ url: 'https://portal.test/p' });
});

describe('startCheckout', () => {
  it('creates the customer on first use, stores it, and sends the owner back to the billing page', async () => {
    const result = await startCheckout(ORG, 'pro');

    expect(result).toEqual({ url: 'https://checkout.test/s' });
    expect(provider.createCheckout).toHaveBeenCalledWith({
      orgId: ORG,
      orgName: 'Acme',
      customerRef: null,
      priceLookupKey: 'pro_monthly',
      successUrl: 'https://app.test/admin/billing?checkout=success',
      cancelUrl: 'https://app.test/admin/billing?checkout=cancelled',
    });
    expect(db.records.get(ORG)).toMatchObject({ provider: 'stripe', customerRef: 'cus_created' });
    // Under the org's billing lock.
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
  });

  it('reuses the stored customer and writes nothing new', async () => {
    db.records.set(ORG, { provider: 'stripe', customerRef: 'cus_a', subscriptionRef: null });

    await startCheckout(ORG, 'pro');

    expect(provider.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ customerRef: 'cus_a' })
    );
    expect(mockPrisma.orgBillingSubscription.upsert).not.toHaveBeenCalled();
  });

  it.each(['active', 'past_due'] as const)(
    'refuses while the org has a %s subscription, creating nothing',
    async (status) => {
      db.records.set(ORG, { provider: 'stripe', customerRef: 'cus_a', subscriptionRef: 'sub_1' });
      provider.fetchSubscription.mockResolvedValue(sub({ status }));

      expect(await refusal(startCheckout(ORG, 'pro'))).toBe('ALREADY_SUBSCRIBED');
      expect(provider.createCheckout).not.toHaveBeenCalled();
      expect(provider.cancelSubscription).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['an incomplete first payment', sub({ status: 'incomplete', providerStatus: 'incomplete' })],
    ['a paused trial', sub({ status: 'ended', providerStatus: 'paused', live: true })],
  ])('cancels %s first, so the org never has two live subscriptions', async (_name, current) => {
    db.records.set(ORG, { provider: 'stripe', customerRef: 'cus_a', subscriptionRef: 'sub_1' });
    provider.fetchSubscription.mockResolvedValue(current);

    await startCheckout(ORG, 'pro');

    expect(provider.cancelSubscription).toHaveBeenCalledWith('sub_1');
    expect(provider.cancelSubscription.mock.invocationCallOrder[0]).toBeLessThan(
      provider.createCheckout.mock.invocationCallOrder[0]
    );
  });

  it('goes ahead over a subscription that ended for good, without cancelling it', async () => {
    db.records.set(ORG, { provider: 'stripe', customerRef: 'cus_a', subscriptionRef: 'sub_1' });
    provider.fetchSubscription.mockResolvedValue(
      sub({ status: 'ended', providerStatus: 'canceled', live: false })
    );

    await startCheckout(ORG, 'pro');

    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(provider.createCheckout).toHaveBeenCalled();
  });

  it('refuses when billing is off, an unknown plan, and a plan with no price', async () => {
    fake.provider = null;
    expect(await refusal(startCheckout(ORG, 'pro'))).toBe('BILLING_OFF');
    fake.provider = provider;
    expect(await refusal(startCheckout(ORG, 'gold'))).toBe('UNKNOWN_PLAN');
    expect(await refusal(startCheckout(ORG, 'free'))).toBe('NOT_PURCHASABLE');
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('says the price is not set up when the provider has none with the lookup key', async () => {
    provider.createCheckout.mockRejectedValue(new BillingPriceMissingError('pro_monthly'));
    expect(await refusal(startCheckout(ORG, 'pro'))).toBe('PRICE_MISSING');
  });

  it('refuses an org that does not exist', async () => {
    expect(await refusal(startCheckout('org_none', 'pro'))).toBe('ORG_NOT_FOUND');
  });
});

describe('openBillingPortal', () => {
  it('opens the stored customer’s portal and returns to the billing page', async () => {
    db.records.set(ORG, { provider: 'stripe', customerRef: 'cus_a', subscriptionRef: 'sub_1' });

    expect(await openBillingPortal(ORG)).toEqual({ url: 'https://portal.test/p' });
    expect(provider.openPortal).toHaveBeenCalledWith({
      customerRef: 'cus_a',
      returnUrl: 'https://app.test/admin/billing',
    });
  });

  it('refuses an org that has never been through checkout, or one at another provider', async () => {
    expect(await refusal(openBillingPortal(ORG))).toBe('NO_CUSTOMER');
    db.records.set(ORG, { provider: 'paddle', customerRef: 'ctm_1', subscriptionRef: null });
    expect(await refusal(openBillingPortal(ORG))).toBe('NO_CUSTOMER');
  });

  it('refuses when billing is off', async () => {
    fake.provider = null;
    expect(await refusal(openBillingPortal(ORG))).toBe('BILLING_OFF');
  });
});
