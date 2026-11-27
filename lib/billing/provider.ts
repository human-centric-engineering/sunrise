/**
 * The payment-provider adapter (§139 t-1094): the interface a provider
 * implements, and the registry an app adds its own provider to.
 *
 * Types are provider-neutral, so no Stripe type crosses this file: the
 * platform's checkout, portal, webhook and erasure code talks to
 * {@link BillingProvider} and never to an SDK. The Stripe adapter ships in core
 * (`lib/billing/providers/stripe.ts`) and is loaded only when
 * `BILLING_PROVIDER=stripe`; an app that needs another provider (a merchant
 * of record, say) registers it from `initAppBilling()` in
 * `lib/app/billing.ts` with {@link registerBillingProvider} and names its key
 * in `BILLING_PROVIDER`.
 *
 * The registry is rolled back with the app's plans: it is in the snapshot of
 * the billing init gate in `lib/billing/plans.ts`, so an init that throws
 * after registering a provider leaves none registered (`platform.seam-design`).
 * Which provider is in use, and building it, is `lib/billing/config.ts`.
 *
 * @see .context/billing/billing.md#the-adapter — the interface, and why it is shaped so
 */

/** What the adapter says changed. It never carries state: the caller fetches that. */
export interface BillingEvent {
  /** The provider's event id: the ledger key. */
  id: string;
  kind: 'subscription_changed' | 'checkout_completed' | 'payment_failed' | 'ignored';
  /** The provider's own type (`customer.subscription.updated`), kept in the ledger. */
  providerType: string;
  customerRef: string | null;
  subscriptionRef: string | null;
}

/**
 * A subscription as the provider holds it now.
 *
 * `status` is about access: `ended` means the org loses what the plan gave
 * it. `live` is about money: whether the provider could still charge for it.
 * An `unpaid` or `paused` Stripe subscription is `ended` and `live`.
 */
export interface ProviderSubscription {
  ref: string;
  customerRef: string;
  status: 'incomplete' | 'active' | 'past_due' | 'ended';
  /** The provider's own word for it (`unpaid`, `trialing`, ...). */
  providerStatus: string;
  priceLookupKeys: string[];
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** When it ended at the provider; `null` while it has not. */
  endedAt: Date | null;
  /** Whether the provider can still charge or resume it. */
  live: boolean;
  /** The org id `createCheckout` wrote into its metadata; `null` when there is none. */
  orgId: string | null;
}

/** The interface every payment provider implements. See the spec for each method's contract. */
export interface BillingProvider {
  /** The value of `BILLING_PROVIDER` that selects it: `'stripe'`. */
  readonly key: string;

  /**
   * A hosted checkout for one plan. Creates the org's customer on first use,
   * or when the provider no longer has the stored one (the answer's
   * `customerRef` is then the new one), and closes the customer's other open
   * checkout pages first,
   * and writes the org id into the metadata of the customer, the session and
   * the subscription, so a webhook can find the org before the customer
   * reference is stored.
   */
  createCheckout(input: {
    orgId: string;
    orgName: string;
    customerRef: string | null;
    priceLookupKey: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; customerRef: string }>;

  /**
   * The provider's own page for changing plan, card or cancelling. Throws
   * {@link BillingCustomerMissingError} when the provider no longer has the
   * customer.
   */
  openPortal(input: { customerRef: string; returnUrl: string }): Promise<{ url: string }>;

  /**
   * Close every checkout page of the customer that is still open, so none
   * can be paid after this. One completed in the meantime is left alone.
   * Called before a new checkout, and by org erasure.
   */
  expireOpenCheckouts(customerRef: string): Promise<void>;

  /**
   * Verify the signature over the raw body, then say what changed. Throws
   * {@link BillingSignatureError} on a bad or stale signature, before anything
   * is parsed.
   */
  parseWebhook(input: { rawBody: string; headers: Headers }): Promise<BillingEvent>;

  /** The subscription as the provider holds it now; `null` if it does not exist. */
  fetchSubscription(subscriptionRef: string): Promise<ProviderSubscription | null>;

  /** Every subscription of the customer that is `live`. */
  listLiveSubscriptions(customerRef: string): Promise<ProviderSubscription[]>;

  /** Every customer whose metadata names the org. Can lag a new customer. */
  findCustomerRefs(orgId: string): Promise<string[]>;

  /**
   * A period's quantity for one metered item; a later report for the same
   * meter and period replaces an earlier one (t-1097 sends them).
   */
  reportUsage(input: {
    customerRef: string;
    subscriptionRef: string;
    providerMeter: string;
    quantity: number;
    periodStart: Date;
    periodEnd: Date;
    final: boolean;
    at: Date;
    identifier: string;
  }): Promise<void>;

  /**
   * End it now, invoicing what is owed so far. One that has already ended,
   * or that the provider does not have, counts as success.
   */
  cancelSubscription(subscriptionRef: string): Promise<void>;
}

/**
 * A webhook whose signature did not verify: wrong secret, a body changed in
 * transit, a stale timestamp, or no signature at all. The route answers 400
 * and reads nothing else.
 */
export class BillingSignatureError extends Error {
  constructor(message = 'The webhook signature did not verify') {
    super(message);
    this.name = 'BillingSignatureError';
  }
}

/**
 * The provider has no active price with the plan's lookup key: the operator
 * has not set it up, or set it in the other mode (test or live). Checkout
 * answers that the plan cannot be bought yet; nothing was created.
 */
export class BillingPriceMissingError extends Error {
  constructor(readonly priceLookupKey: string) {
    super(`The payment provider has no active price with the lookup key "${priceLookupKey}"`);
    this.name = 'BillingPriceMissingError';
  }
}

/**
 * The provider no longer has the customer the org's record names (deleted
 * in the provider's dashboard, say). The portal answers that the org has no
 * billing account; a checkout makes a new customer.
 */
export class BillingCustomerMissingError extends Error {
  constructor(readonly customerRef: string) {
    super(`The payment provider has no customer "${customerRef}"`);
    this.name = 'BillingCustomerMissingError';
  }
}

/** The key of the provider that ships in core. An app cannot register it. */
export const STRIPE_PROVIDER_KEY = 'stripe';

/**
 * A provider an app registers. `create` runs once, when the provider is first
 * used with `BILLING_PROVIDER` naming it, so an SDK it imports is loaded only
 * then. Read the provider's own secrets inside it, from `lib/app/env.ts`.
 */
export interface BillingProviderRegistration {
  /** What `BILLING_PROVIDER` is set to: lower-case letters, digits, `_` and `-`. */
  key: string;
  create: () => BillingProvider | Promise<BillingProvider>;
  /**
   * Whether the secrets it needs are set, so config health can say so and
   * billing stays off rather than failing at the first checkout. Presence
   * only, never a value. Left out, it counts as configured.
   */
  configured?: () => boolean;
}

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

const providers = new Map<string, BillingProviderRegistration>();

/**
 * Register a payment provider. Call from `initAppBilling()` in
 * `lib/app/billing.ts`. Re-registering a key replaces it. A key that is not
 * a key, `stripe` (core's own), or a registration with no `create` throws,
 * which rolls back every plan and provider the init registered.
 */
export function registerBillingProvider(registration: BillingProviderRegistration): void {
  const key: unknown = registration.key;
  if (typeof key !== 'string' || !PROVIDER_KEY_PATTERN.test(key)) {
    throw new Error(
      `Billing provider key "${String(key)}" must be lower-case letters, digits, _ and -, starting with a letter, at most 40 characters`
    );
  }
  if (key === STRIPE_PROVIDER_KEY) {
    throw new Error(
      'The "stripe" billing provider ships in core; register yours under another key'
    );
  }
  if (typeof registration.create !== 'function') {
    throw new Error(`Billing provider "${key}" needs a create() function`);
  }
  providers.set(key, Object.freeze({ ...registration }));
}

/**
 * The app's registered providers, as a map the billing init gate snapshots
 * and restores. Not for reading which provider is in use: that is
 * `billingProvider()` in `lib/billing/config.ts`, which runs the init first.
 */
export function billingProviderRegistry(): Map<string, BillingProviderRegistration> {
  return providers;
}
