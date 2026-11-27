/**
 * The Stripe adapter (§139 t-1094): {@link BillingProvider} over the `stripe`
 * SDK.
 *
 * **Loaded only when chosen.** `lib/billing/config.ts` imports this module
 * with a dynamic `import()` when `BILLING_PROVIDER=stripe`, and nothing else
 * imports it, so the SDK is never loaded on an install that does not bill
 * (`tests/unit/lib/billing/config.test.ts` holds that). Do not import it
 * statically.
 *
 * **The API version is pinned here** ({@link STRIPE_API_VERSION}), so an SDK
 * upgrade does not move it silently. The webhook reads only each event's id,
 * type and object references and fetches the subscription itself, so the
 * version the endpoint is registered with in the Dashboard matters less than
 * it would if event snapshots were applied.
 *
 * No Stripe type leaves this file. The mapping from Stripe's statuses to the
 * neutral ones is {@link toProviderSubscription}, and from events to
 * {@link BillingEvent} is {@link toBillingEvent}; both are pure, and tested
 * on their own.
 *
 * @see .context/billing/billing.md#the-adapter
 */

import Stripe from 'stripe';

import {
  BillingPriceMissingError,
  BillingSignatureError,
  STRIPE_PROVIDER_KEY,
  type BillingEvent,
  type BillingProvider,
  type ProviderSubscription,
} from '@/lib/billing/provider';

/** The Stripe API version every request is made at. Move it deliberately. */
export const STRIPE_API_VERSION = '2026-10-28.endive';

/** The metadata key that names the org on a customer, session and subscription. */
export const STRIPE_ORG_METADATA_KEY = 'sunrise_org_id';

/** What an org id must look like to go into a customer search query. */
const SEARCHABLE_ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface StripeProviderOptions {
  secretKey: string;
  webhookSecret: string;
  /** Where the API is; tests point it at `stripe-mock`. Default: Stripe. */
  api?: { host: string; port: number; protocol: 'http' | 'https' };
}

type StripeId = string | { id: string } | null | undefined;

function refOf(value: StripeId): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.id;
}

function dateOf(seconds: number): Date {
  return new Date(seconds * 1000);
}

/** Whether Stripe could still charge for or resume a subscription in this status. */
function isLive(status: string): boolean {
  return status !== 'canceled' && status !== 'incomplete_expired';
}

/** Stripe's status, as it bears on access (the spec's mapping table). */
function neutralStatus(status: string): ProviderSubscription['status'] {
  switch (status) {
    case 'trialing':
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'incomplete':
      return 'incomplete';
    default:
      // canceled, unpaid, incomplete_expired, paused, and any status a later
      // API version adds: access stops until it is understood.
      return 'ended';
  }
}

/** A Stripe subscription in the neutral shape. */
export function toProviderSubscription(subscription: Stripe.Subscription): ProviderSubscription {
  const items = subscription.items.data;
  // Since 2025-03-31.basil the period is on each item, not the subscription.
  // Items on one subscription share a period; the widest is taken in case
  // they do not.
  const starts = items.map((item) => item.current_period_start);
  const ends = items.map((item) => item.current_period_end);
  const periodStart = starts.length > 0 ? Math.min(...starts) : subscription.start_date;
  const periodEnd = ends.length > 0 ? Math.max(...ends) : subscription.start_date;
  const lookupKeys = items
    .map((item) => item.price.lookup_key)
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  const orgId = subscription.metadata[STRIPE_ORG_METADATA_KEY];
  return {
    ref: subscription.id,
    customerRef: refOf(subscription.customer) ?? '',
    status: neutralStatus(subscription.status),
    providerStatus: subscription.status,
    priceLookupKeys: [...new Set(lookupKeys)],
    periodStart: dateOf(periodStart),
    periodEnd: dateOf(periodEnd),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    endedAt: subscription.ended_at === null ? null : dateOf(subscription.ended_at),
    live: isLive(subscription.status),
    orgId: typeof orgId === 'string' && orgId.length > 0 ? orgId : null,
  };
}

/** The events the webhook acts on. Every other type is answered and ignored. */
export const STRIPE_WEBHOOK_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'checkout.session.completed',
  'invoice.payment_failed',
] as const;

/** What a verified Stripe event says changed. */
export function toBillingEvent(event: Stripe.Event): BillingEvent {
  const base = { id: event.id, providerType: event.type };
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const subscription = event.data.object;
      return {
        ...base,
        kind: 'subscription_changed',
        customerRef: refOf(subscription.customer),
        subscriptionRef: subscription.id,
      };
    }
    case 'checkout.session.completed': {
      const session = event.data.object;
      // A one-off payment checkout is not one the platform made.
      if (session.mode !== 'subscription') {
        return { ...base, kind: 'ignored', customerRef: null, subscriptionRef: null };
      }
      return {
        ...base,
        kind: 'checkout_completed',
        customerRef: refOf(session.customer),
        subscriptionRef: refOf(session.subscription),
      };
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      return {
        ...base,
        kind: 'payment_failed',
        customerRef: refOf(invoice.customer),
        subscriptionRef: refOf(invoice.parent?.subscription_details?.subscription),
      };
    }
    default:
      return { ...base, kind: 'ignored', customerRef: null, subscriptionRef: null };
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing'
  );
}

/** Build the adapter. Called once, by `lib/billing/config.ts`. */
export function createStripeProvider(options: StripeProviderOptions): BillingProvider {
  const stripe = new Stripe(options.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'Sunrise billing' },
    ...(options.api ?? {}),
  });

  async function fetchSubscription(subscriptionRef: string): Promise<ProviderSubscription | null> {
    try {
      return toProviderSubscription(await stripe.subscriptions.retrieve(subscriptionRef));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  return {
    key: STRIPE_PROVIDER_KEY,

    async createCheckout(input) {
      const prices = await stripe.prices.list({
        lookup_keys: [input.priceLookupKey],
        active: true,
        limit: 1,
      });
      const price = prices.data[0];
      if (!price) throw new BillingPriceMissingError(input.priceLookupKey);

      const metadata = { [STRIPE_ORG_METADATA_KEY]: input.orgId };
      const customerRef =
        input.customerRef ?? (await stripe.customers.create({ name: input.orgName, metadata })).id;

      // One open checkout per customer: a page left open in another tab and
      // paid after this one would start a second subscription. One that
      // completed in the meantime can no longer be expired, and is the
      // webhook's to record.
      if (input.customerRef !== null) {
        for await (const open of stripe.checkout.sessions.list({
          customer: customerRef,
          status: 'open',
          limit: 100,
        })) {
          await stripe.checkout.sessions.expire(open.id).catch((error: unknown) => {
            if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error;
          });
        }
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerRef,
        client_reference_id: input.orgId,
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata,
        subscription_data: { metadata },
      });
      if (!session.url) throw new Error('Stripe returned a checkout session with no URL');
      return { url: session.url, customerRef };
    },

    async openPortal(input) {
      const session = await stripe.billingPortal.sessions.create({
        customer: input.customerRef,
        return_url: input.returnUrl,
      });
      return { url: session.url };
    },

    parseWebhook(input) {
      const signature = input.headers.get('stripe-signature');
      if (!signature) {
        return Promise.reject(
          new BillingSignatureError('The webhook has no Stripe-Signature header')
        );
      }
      let event: Stripe.Event;
      try {
        // Verifies the HMAC over the raw bytes and refuses a timestamp older
        // than five minutes, before anything is parsed.
        event = stripe.webhooks.constructEvent(input.rawBody, signature, options.webhookSecret);
      } catch (error) {
        if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
          return Promise.reject(new BillingSignatureError());
        }
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return Promise.resolve(toBillingEvent(event));
    },

    fetchSubscription,

    async listLiveSubscriptions(customerRef) {
      const live: ProviderSubscription[] = [];
      try {
        for await (const subscription of stripe.subscriptions.list({
          customer: customerRef,
          status: 'all',
          limit: 100,
        })) {
          if (isLive(subscription.status)) live.push(toProviderSubscription(subscription));
        }
      } catch (error) {
        // A customer deleted at Stripe has no subscriptions: deleting it
        // cancels them. Read as none, so erasure is not stuck retrying.
        if (isMissing(error)) return [];
        throw error;
      }
      return live;
    },

    async findCustomerRefs(orgId) {
      // The org id goes into a query string, so only an id that cannot
      // change the query's meaning is searched for.
      if (!SEARCHABLE_ORG_ID.test(orgId)) return [];
      const refs: string[] = [];
      for await (const customer of stripe.customers.search({
        query: `metadata['${STRIPE_ORG_METADATA_KEY}']:'${orgId}'`,
        limit: 100,
      })) {
        refs.push(customer.id);
      }
      return refs;
    },

    async reportUsage(input) {
      await stripe.billing.meterEvents.create({
        event_name: input.providerMeter,
        identifier: input.identifier,
        timestamp: Math.floor(input.at.getTime() / 1000),
        payload: {
          stripe_customer_id: input.customerRef,
          value: String(Math.trunc(input.quantity)),
        },
      });
    },

    async cancelSubscription(subscriptionRef) {
      const current = await fetchSubscription(subscriptionRef);
      if (!current?.live) return;
      try {
        await stripe.subscriptions.cancel(subscriptionRef, { invoice_now: true, prorate: false });
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    },
  };
}
