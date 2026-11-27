/**
 * Unit Tests: what the Stripe adapter asks Stripe for (§139 t-1094)
 *
 * The `stripe` SDK is replaced by a recorder, so these pin the requests the
 * adapter makes and how it reads the answers: the price by lookup key, the
 * customer created once with the org in its metadata, the org written on the
 * session and the subscription, the API version pinned, a missing
 * subscription read as `null`, only live subscriptions listed, the customer
 * search refusing an id that could change the query, the meter event's
 * shape, and a cancellation that is a no-op once ended. That each request is
 * valid against Stripe's own spec is the smoke's stripe-mock section
 * (`npm run smoke:billing-webhook`); the signature check, against the real
 * SDK, is `stripe.test.ts`.
 *
 * @see lib/billing/providers/stripe.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  class StripeInvalidRequestError extends Error {
    code?: string;
    constructor(code?: string) {
      super(code ?? 'invalid');
      this.code = code;
    }
  }
  class StripeSignatureVerificationError extends Error {}
  async function* pages<T>(items: T[]): AsyncGenerator<T> {
    for (const item of items) yield await Promise.resolve(item);
  }
  const calls = {
    constructed: [] as unknown[],
    pricesList: vi.fn(),
    customersCreate: vi.fn(),
    customersRetrieve: vi.fn(),
    customersSearch: vi.fn(),
    sessionsCreate: vi.fn(),
    sessionsList: vi.fn(),
    sessionsExpire: vi.fn(),
    portalCreate: vi.fn(),
    subsRetrieve: vi.fn(),
    subsList: vi.fn(),
    subsCancel: vi.fn(),
    meterEventsCreate: vi.fn(),
    constructEvent: vi.fn(),
  };
  return { calls, pages, StripeInvalidRequestError, StripeSignatureVerificationError };
});

vi.mock('stripe', () => {
  class Stripe {
    static errors = {
      StripeInvalidRequestError: sdk.StripeInvalidRequestError,
      StripeSignatureVerificationError: sdk.StripeSignatureVerificationError,
    };
    prices = { list: sdk.calls.pricesList };
    customers = {
      create: sdk.calls.customersCreate,
      retrieve: sdk.calls.customersRetrieve,
      search: sdk.calls.customersSearch,
    };
    checkout = {
      sessions: {
        create: sdk.calls.sessionsCreate,
        list: sdk.calls.sessionsList,
        expire: sdk.calls.sessionsExpire,
      },
    };
    billingPortal = { sessions: { create: sdk.calls.portalCreate } };
    subscriptions = {
      retrieve: sdk.calls.subsRetrieve,
      list: sdk.calls.subsList,
      cancel: sdk.calls.subsCancel,
    };
    billing = { meterEvents: { create: sdk.calls.meterEventsCreate } };
    webhooks = { constructEvent: sdk.calls.constructEvent };
    constructor(...args: unknown[]) {
      sdk.calls.constructed.push(args);
    }
  }
  return { default: Stripe };
});

import {
  BillingCustomerMissingError,
  BillingPriceMissingError,
  BillingSignatureError,
} from '@/lib/billing/provider';
import { createStripeProvider, STRIPE_API_VERSION } from '@/lib/billing/providers/stripe';

const calls = sdk.calls;

function stripeSub(id: string, status: string) {
  return {
    id,
    customer: 'cus_1',
    status,
    cancel_at_period_end: false,
    ended_at: null,
    start_date: 1,
    metadata: {},
    items: {
      data: [{ current_period_start: 1, current_period_end: 2, price: { lookup_key: 'pro' } }],
    },
  };
}

let provider: ReturnType<typeof createStripeProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  calls.constructed.length = 0;
  provider = createStripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' });
  calls.pricesList.mockResolvedValue({ data: [{ id: 'price_1' }] });
  calls.sessionsList.mockImplementation(() => sdk.pages([]));
  calls.sessionsExpire.mockResolvedValue({});
  calls.customersRetrieve.mockResolvedValue({ id: 'cus_old' });
  calls.customersCreate.mockResolvedValue({ id: 'cus_new' });
  calls.sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/s' });
  calls.portalCreate.mockResolvedValue({ url: 'https://billing.stripe.test/p' });
});

describe('the client', () => {
  it('is made with the secret key and the pinned API version', () => {
    expect(calls.constructed[0]).toEqual([
      'sk_test_x',
      expect.objectContaining({ apiVersion: STRIPE_API_VERSION }),
    ]);
  });
});

describe('createCheckout', () => {
  const input = {
    orgId: 'org_a',
    orgName: 'Acme',
    customerRef: null,
    priceLookupKey: 'pro_monthly',
    successUrl: 'https://app.test/s',
    cancelUrl: 'https://app.test/c',
  };

  it('finds the price by lookup key, creates the customer, and names the org everywhere', async () => {
    const result = await provider.createCheckout(input);

    expect(calls.pricesList).toHaveBeenCalledWith({
      lookup_keys: ['pro_monthly'],
      active: true,
      limit: 1,
    });
    expect(calls.customersCreate).toHaveBeenCalledWith({
      name: 'Acme',
      metadata: { sunrise_org_id: 'org_a' },
    });
    expect(calls.sessionsCreate).toHaveBeenCalledWith({
      mode: 'subscription',
      customer: 'cus_new',
      client_reference_id: 'org_a',
      line_items: [{ price: 'price_1', quantity: 1 }],
      success_url: 'https://app.test/s',
      cancel_url: 'https://app.test/c',
      metadata: { sunrise_org_id: 'org_a' },
      subscription_data: { metadata: { sunrise_org_id: 'org_a' } },
    });
    expect(result).toEqual({ url: 'https://checkout.stripe.test/s', customerRef: 'cus_new' });
  });

  it('looks for no open checkouts for a customer it has just created', async () => {
    await provider.createCheckout(input);
    expect(calls.sessionsList).not.toHaveBeenCalled();
  });

  it('expires the stored customer’s other open checkouts, so two tabs cannot both be paid', async () => {
    calls.sessionsList.mockImplementation(() => sdk.pages([{ id: 'cs_tab1' }, { id: 'cs_done' }]));
    calls.sessionsExpire.mockImplementation(async (id: string) => {
      // Completed between the list and the expire: no longer open.
      if (id === 'cs_done') throw new sdk.StripeInvalidRequestError('checkout_session_not_open');
      return {};
    });

    await provider.createCheckout({ ...input, customerRef: 'cus_old' });

    expect(calls.sessionsList).toHaveBeenCalledWith({
      customer: 'cus_old',
      status: 'open',
      limit: 100,
    });
    expect(calls.sessionsExpire).toHaveBeenCalledWith('cs_tab1');
    expect(calls.sessionsCreate).toHaveBeenCalled();
  });

  it('does not make a checkout when an open one could not be expired for another reason', async () => {
    calls.sessionsList.mockImplementation(() => sdk.pages([{ id: 'cs_tab1' }]));
    calls.sessionsExpire.mockRejectedValue(new Error('network'));
    await expect(provider.createCheckout({ ...input, customerRef: 'cus_old' })).rejects.toThrow(
      'network'
    );
    expect(calls.sessionsCreate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'marked deleted',
      () => calls.customersRetrieve.mockResolvedValue({ id: 'cus_old', deleted: true }),
    ],
    [
      'missing',
      () =>
        calls.customersRetrieve.mockRejectedValue(
          new sdk.StripeInvalidRequestError('resource_missing')
        ),
    ],
  ])('makes a new customer when the stored one is %s at Stripe', async (_name, arrange) => {
    arrange();

    const result = await provider.createCheckout({ ...input, customerRef: 'cus_old' });

    expect(calls.customersCreate).toHaveBeenCalled();
    expect(calls.sessionsList).not.toHaveBeenCalled();
    expect(result.customerRef).toBe('cus_new');
  });

  it('reuses a stored customer', async () => {
    await provider.createCheckout({ ...input, customerRef: 'cus_old' });
    expect(calls.customersCreate).not.toHaveBeenCalled();
    expect(calls.sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_old' })
    );
  });

  it('says the price is missing, creating nothing, when no active price has the key', async () => {
    calls.pricesList.mockResolvedValue({ data: [] });
    await expect(provider.createCheckout(input)).rejects.toBeInstanceOf(BillingPriceMissingError);
    expect(calls.customersCreate).not.toHaveBeenCalled();
    expect(calls.sessionsCreate).not.toHaveBeenCalled();
  });

  it('refuses a session with no URL', async () => {
    calls.sessionsCreate.mockResolvedValue({ url: null });
    await expect(provider.createCheckout(input)).rejects.toThrow(/no URL/);
  });
});

describe('openPortal', () => {
  it('opens the customer’s portal with the return URL', async () => {
    const result = await provider.openPortal({
      customerRef: 'cus_1',
      returnUrl: 'https://app.test/r',
    });
    expect(calls.portalCreate).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: 'https://app.test/r',
    });
    expect(result).toEqual({ url: 'https://billing.stripe.test/p' });
  });
});

describe('openPortal and expireOpenCheckouts, for a customer Stripe no longer has', () => {
  it('the portal says the customer is missing; other errors pass on', async () => {
    calls.portalCreate.mockRejectedValueOnce(new sdk.StripeInvalidRequestError('resource_missing'));
    await expect(
      provider.openPortal({ customerRef: 'cus_gone', returnUrl: 'https://app.test/r' })
    ).rejects.toBeInstanceOf(BillingCustomerMissingError);
    calls.portalCreate.mockRejectedValueOnce(new Error('network'));
    await expect(
      provider.openPortal({ customerRef: 'cus_1', returnUrl: 'https://app.test/r' })
    ).rejects.toThrow('network');
  });

  it('there are no open checkouts to expire', async () => {
    calls.sessionsList.mockImplementation(() => {
      throw new sdk.StripeInvalidRequestError('resource_missing');
    });
    await expect(provider.expireOpenCheckouts('cus_gone')).resolves.toBeUndefined();
    calls.sessionsList.mockImplementation(() => {
      throw new Error('network');
    });
    await expect(provider.expireOpenCheckouts('cus_1')).rejects.toThrow('network');
  });
});

describe('parseWebhook', () => {
  it('verifies with the endpoint secret and maps the event', async () => {
    calls.constructEvent.mockReturnValue({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_1' } },
    });
    const event = await provider.parseWebhook({
      rawBody: '{}',
      headers: new Headers({ 'stripe-signature': 'sig' }),
    });
    expect(calls.constructEvent).toHaveBeenCalledWith('{}', 'sig', 'whsec_x');
    expect(event).toMatchObject({ id: 'evt_1', subscriptionRef: 'sub_1' });
  });

  it('turns the SDK’s refusal into a BillingSignatureError, and passes any other error on', async () => {
    const headers = new Headers({ 'stripe-signature': 'sig' });
    calls.constructEvent.mockImplementation(() => {
      throw new sdk.StripeSignatureVerificationError('bad');
    });
    await expect(provider.parseWebhook({ rawBody: '{}', headers })).rejects.toBeInstanceOf(
      BillingSignatureError
    );
    calls.constructEvent.mockImplementation(() => {
      throw new Error('something else');
    });
    await expect(provider.parseWebhook({ rawBody: '{}', headers })).rejects.toThrow(
      'something else'
    );
  });
});

describe('subscriptions', () => {
  it('fetches one, and reads one Stripe does not have as null', async () => {
    calls.subsRetrieve.mockResolvedValueOnce(stripeSub('sub_1', 'active'));
    expect((await provider.fetchSubscription('sub_1'))?.status).toBe('active');

    calls.subsRetrieve.mockRejectedValueOnce(new sdk.StripeInvalidRequestError('resource_missing'));
    expect(await provider.fetchSubscription('sub_gone')).toBeNull();

    calls.subsRetrieve.mockRejectedValueOnce(
      new sdk.StripeInvalidRequestError('parameter_invalid')
    );
    await expect(provider.fetchSubscription('sub_bad')).rejects.toThrow();
  });

  it('lists only the live ones of a customer, across every status', async () => {
    calls.subsList.mockReturnValue(
      sdk.pages([
        stripeSub('sub_active', 'active'),
        stripeSub('sub_unpaid', 'unpaid'),
        stripeSub('sub_paused', 'paused'),
        stripeSub('sub_cancelled', 'canceled'),
        stripeSub('sub_expired', 'incomplete_expired'),
      ])
    );

    const live = await provider.listLiveSubscriptions('cus_1');

    expect(calls.subsList).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 });
    expect(live.map((s) => s.ref)).toEqual(['sub_active', 'sub_unpaid', 'sub_paused']);
  });

  it('reads a customer Stripe no longer has as having no live subscriptions', async () => {
    calls.subsList.mockImplementation(() => {
      throw new sdk.StripeInvalidRequestError('resource_missing');
    });
    expect(await provider.listLiveSubscriptions('cus_deleted')).toEqual([]);
    calls.subsList.mockImplementation(() => {
      throw new Error('network');
    });
    await expect(provider.listLiveSubscriptions('cus_1')).rejects.toThrow('network');
  });

  it('cancels a live one with what is owed invoiced, and treats ended or missing as done', async () => {
    calls.subsRetrieve.mockResolvedValueOnce(stripeSub('sub_1', 'unpaid'));
    await provider.cancelSubscription('sub_1');
    expect(calls.subsCancel).toHaveBeenCalledWith('sub_1', { invoice_now: true, prorate: false });

    calls.subsCancel.mockClear();
    calls.subsRetrieve.mockResolvedValueOnce(stripeSub('sub_2', 'canceled'));
    await provider.cancelSubscription('sub_2');
    calls.subsRetrieve.mockRejectedValueOnce(new sdk.StripeInvalidRequestError('resource_missing'));
    await provider.cancelSubscription('sub_3');
    expect(calls.subsCancel).not.toHaveBeenCalled();

    // Gone between the read and the cancel: still the outcome the caller needs.
    calls.subsRetrieve.mockResolvedValueOnce(stripeSub('sub_4', 'active'));
    calls.subsCancel.mockRejectedValueOnce(new sdk.StripeInvalidRequestError('resource_missing'));
    await expect(provider.cancelSubscription('sub_4')).resolves.toBeUndefined();

    calls.subsRetrieve.mockResolvedValueOnce(stripeSub('sub_5', 'active'));
    calls.subsCancel.mockRejectedValueOnce(new Error('card network down'));
    await expect(provider.cancelSubscription('sub_5')).rejects.toThrow('card network down');
  });
});

describe('findCustomerRefs', () => {
  it('searches customers by the org id in their metadata', async () => {
    calls.customersSearch.mockReturnValue(sdk.pages([{ id: 'cus_1' }, { id: 'cus_2' }]));
    expect(await provider.findCustomerRefs('cmorg_0001')).toEqual(['cus_1', 'cus_2']);
    expect(calls.customersSearch).toHaveBeenCalledWith({
      query: "metadata['sunrise_org_id']:'cmorg_0001'",
      limit: 100,
    });
  });

  it("never searches with an id that could change the query's meaning", async () => {
    expect(await provider.findCustomerRefs("x' OR name:'y")).toEqual([]);
    expect(calls.customersSearch).not.toHaveBeenCalled();
  });
});

describe('reportUsage', () => {
  it('sends one meter event: the customer, a whole quantity, the identifier, at the given second', async () => {
    await provider.reportUsage({
      customerRef: 'cus_1',
      subscriptionRef: 'sub_1',
      providerMeter: 'api_calls',
      quantity: 42.9,
      periodStart: new Date('2026-11-01T00:00:00Z'),
      periodEnd: new Date('2026-12-01T00:00:00Z'),
      final: true,
      at: new Date('2026-11-30T23:59:59Z'),
      identifier: 'report_1',
    });
    expect(calls.meterEventsCreate).toHaveBeenCalledWith({
      event_name: 'api_calls',
      identifier: 'report_1',
      timestamp: Date.parse('2026-11-30T23:59:59Z') / 1000,
      payload: { stripe_customer_id: 'cus_1', value: '42' },
    });
  });
});
