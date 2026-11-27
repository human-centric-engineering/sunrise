/**
 * Unit Tests: the Stripe adapter's mapping and its signature check (§139 t-1094)
 *
 * The real SDK's webhook verification over bodies signed the way Stripe
 * signs them (`generateTestHeaderString`), and the pure mappings from a
 * Stripe subscription and event to the neutral shapes. No network: the
 * adapter's requests against `stripe-mock` are `stripe-mock.test.ts`.
 *
 * @see lib/billing/providers/stripe.ts
 */

import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';

import { BillingSignatureError } from '@/lib/billing/provider';
import {
  createStripeProvider,
  STRIPE_ORG_METADATA_KEY,
  toBillingEvent,
  toProviderSubscription,
} from '@/lib/billing/providers/stripe';

const SECRET = 'whsec_test_secret_for_unit_tests';
const sdk = new Stripe('sk_test_unit');
const provider = createStripeProvider({ secretKey: 'sk_test_unit', webhookSecret: SECRET });

/** A minimal Stripe subscription, typed as the SDK types it. */
function subscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    ended_at: null,
    start_date: 1_700_000_000,
    metadata: { [STRIPE_ORG_METADATA_KEY]: 'org_a' },
    items: {
      object: 'list',
      data: [
        {
          id: 'si_1',
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          price: { id: 'price_1', lookup_key: 'pro_monthly' },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function signed(payload: string, secret = SECRET, timestamp?: number): Headers {
  const header = sdk.webhooks.generateTestHeaderString({ payload, secret, timestamp });
  return new Headers({ 'stripe-signature': header });
}

function eventBody(type: string, object: Record<string, unknown>): string {
  return JSON.stringify({
    id: 'evt_1',
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
}

describe('toProviderSubscription', () => {
  it.each([
    ['trialing', 'active', true],
    ['active', 'active', true],
    ['past_due', 'past_due', true],
    ['incomplete', 'incomplete', true],
    ['canceled', 'ended', false],
    ['unpaid', 'ended', true],
    ['incomplete_expired', 'ended', false],
    ['paused', 'ended', true],
    ['some_future_status', 'ended', true],
  ])('maps Stripe %s to %s, live %s', (stripeStatus, neutral, live) => {
    const mapped = toProviderSubscription(subscription({ status: stripeStatus }));
    expect(mapped.status).toBe(neutral);
    expect(mapped.live).toBe(live);
    expect(mapped.providerStatus).toBe(stripeStatus);
  });

  it('reads the period from the items, as the API has since basil', () => {
    const mapped = toProviderSubscription(subscription());
    expect(mapped.periodStart).toEqual(new Date(1_700_000_000 * 1000));
    expect(mapped.periodEnd).toEqual(new Date(1_702_592_000 * 1000));
  });

  it('takes the price lookup keys, the customer, the org id and the end', () => {
    const mapped = toProviderSubscription(
      subscription({
        customer: { id: 'cus_expanded' },
        cancel_at_period_end: true,
        ended_at: 1_701_000_000,
      })
    );
    expect(mapped).toMatchObject({
      ref: 'sub_1',
      customerRef: 'cus_expanded',
      priceLookupKeys: ['pro_monthly'],
      cancelAtPeriodEnd: true,
      endedAt: new Date(1_701_000_000 * 1000),
      orgId: 'org_a',
    });
  });

  it('has no org id when the metadata carries none, and skips a price with no lookup key', () => {
    const mapped = toProviderSubscription(
      subscription({
        metadata: {},
        items: {
          object: 'list',
          data: [
            {
              id: 'si_1',
              current_period_start: 1,
              current_period_end: 2,
              price: { id: 'price_1', lookup_key: null },
            },
          ],
        },
      })
    );
    expect(mapped.orgId).toBeNull();
    expect(mapped.priceLookupKeys).toEqual([]);
  });
});

describe('toBillingEvent', () => {
  it.each([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'customer.subscription.paused',
    'customer.subscription.resumed',
  ])('reads %s as a subscription change, by reference only', (type) => {
    const event = JSON.parse(eventBody(type, { id: 'sub_9', customer: 'cus_9' })) as Stripe.Event;
    expect(toBillingEvent(event)).toEqual({
      id: 'evt_1',
      kind: 'subscription_changed',
      providerType: type,
      customerRef: 'cus_9',
      subscriptionRef: 'sub_9',
    });
  });

  it('reads a completed subscription checkout, and ignores a one-off payment', () => {
    const completed = JSON.parse(
      eventBody('checkout.session.completed', {
        id: 'cs_1',
        mode: 'subscription',
        customer: 'cus_1',
        subscription: 'sub_1',
      })
    ) as Stripe.Event;
    expect(toBillingEvent(completed)).toMatchObject({
      kind: 'checkout_completed',
      customerRef: 'cus_1',
      subscriptionRef: 'sub_1',
    });

    const payment = JSON.parse(
      eventBody('checkout.session.completed', { id: 'cs_2', mode: 'payment', customer: 'cus_1' })
    ) as Stripe.Event;
    expect(toBillingEvent(payment).kind).toBe('ignored');
  });

  it('reads a failed payment with its subscription from the invoice parent', () => {
    const event = JSON.parse(
      eventBody('invoice.payment_failed', {
        id: 'in_1',
        customer: 'cus_1',
        parent: { subscription_details: { subscription: 'sub_1' } },
      })
    ) as Stripe.Event;
    expect(toBillingEvent(event)).toMatchObject({
      kind: 'payment_failed',
      customerRef: 'cus_1',
      subscriptionRef: 'sub_1',
    });
  });

  it('ignores every other type', () => {
    const event = JSON.parse(eventBody('charge.succeeded', { id: 'ch_1' })) as Stripe.Event;
    expect(toBillingEvent(event)).toMatchObject({
      kind: 'ignored',
      providerType: 'charge.succeeded',
    });
  });
});

describe('parseWebhook', () => {
  const body = eventBody('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1' });

  it('accepts a body signed with the endpoint secret', async () => {
    const event = await provider.parseWebhook({ rawBody: body, headers: signed(body) });
    expect(event).toMatchObject({ id: 'evt_1', kind: 'subscription_changed' });
  });

  it('refuses a body parsed and re-serialised after signing', async () => {
    const headers = signed(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    await expect(provider.parseWebhook({ rawBody: reserialised, headers })).rejects.toBeInstanceOf(
      BillingSignatureError
    );
  });

  it('refuses a signature made with another secret', async () => {
    await expect(
      provider.parseWebhook({ rawBody: body, headers: signed(body, 'whsec_someone_else') })
    ).rejects.toBeInstanceOf(BillingSignatureError);
  });

  it('refuses a signature older than five minutes', async () => {
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    await expect(
      provider.parseWebhook({ rawBody: body, headers: signed(body, SECRET, stale) })
    ).rejects.toBeInstanceOf(BillingSignatureError);
  });

  it('refuses a request with no signature header, or one with no v1', async () => {
    await expect(
      provider.parseWebhook({ rawBody: body, headers: new Headers() })
    ).rejects.toBeInstanceOf(BillingSignatureError);
    const t = Math.floor(Date.now() / 1000);
    await expect(
      provider.parseWebhook({
        rawBody: body,
        headers: new Headers({ 'stripe-signature': `t=${t}` }),
      })
    ).rejects.toBeInstanceOf(BillingSignatureError);
  });
});
