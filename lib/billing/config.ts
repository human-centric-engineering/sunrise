/**
 * Whether billing is on, and the payment provider in use (§139 t-1094).
 *
 * Billing is on when `BILLING_PROVIDER` names a provider, the install runs at
 * `TENANCY_MODE=multi`, and the provider's secrets are set. Anything short of
 * that leaves it off and says why ({@link billingProviderState}), which config
 * health reports; none of it throws at boot. A value that is set but has the
 * wrong shape (`Stripe`, a publishable `pk_` key in `STRIPE_SECRET_KEY`) is
 * different: `lib/env.ts` fails the boot naming the variable, as it does for
 * every server variable.
 *
 * **The provider is built on first use, and only then.** The Stripe adapter's
 * module, and with it the `stripe` package, is loaded by a dynamic `import()`
 * inside {@link billingProvider}, which returns before reaching it unless
 * billing is on with `stripe` chosen. So an install that never bills never
 * loads the SDK. A provider an app registers is built the same way, from its
 * `create()`.
 *
 * @see lib/billing/provider.ts — the interface and the app's registry
 * @see .context/billing/billing.md#switching-it-on
 */

import {
  billingProviderRegistry,
  STRIPE_PROVIDER_KEY,
  type BillingProvider,
} from '@/lib/billing/provider';
import { billingPlansFailed, ensureAppBillingInit } from '@/lib/billing/plans';
import { env } from '@/lib/env';
import { isMultiTenant } from '@/lib/tenancy/context';

/** Why billing is off, when it is. */
export type BillingOffReason =
  /** `BILLING_PROVIDER` is not set: the default. */
  | 'unset'
  /** Set at `TENANCY_MODE=single`, where billing does not apply. */
  | 'single_tenant'
  /** It names a provider neither core nor the app registers. */
  | 'unknown_provider'
  /** The provider's secrets are not all set. */
  | 'not_configured'
  /** The app's `initAppBilling()` threw, so its provider, if any, is not registered. */
  | 'registration_failed';

export type BillingProviderState =
  | { on: true; providerKey: string }
  | { on: false; reason: BillingOffReason; providerKey: string | null };

/** Whether Stripe's two secrets are set. Presence only. */
export function stripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

/** Whether billing is on, and if not, why. Read on every call, never cached. */
export function billingProviderState(): BillingProviderState {
  const providerKey = env.BILLING_PROVIDER ?? null;
  if (providerKey === null) return { on: false, reason: 'unset', providerKey };
  if (!isMultiTenant()) return { on: false, reason: 'single_tenant', providerKey };
  if (providerKey === STRIPE_PROVIDER_KEY) {
    return stripeConfigured()
      ? { on: true, providerKey }
      : { on: false, reason: 'not_configured', providerKey };
  }
  ensureAppBillingInit();
  const registration = billingProviderRegistry().get(providerKey);
  if (!registration) {
    return {
      on: false,
      reason: billingPlansFailed() ? 'registration_failed' : 'unknown_provider',
      providerKey,
    };
  }
  if (registration.configured && !registration.configured()) {
    return { on: false, reason: 'not_configured', providerKey };
  }
  return { on: true, providerKey };
}

/** Whether billing is on: a provider chosen, configured, at `multi`. */
export function billingEnabled(): boolean {
  return billingProviderState().on;
}

/** What a caller is told when billing is off. */
export const BILLING_OFF_MESSAGE = 'Billing is not switched on for this install';

let built: { key: string; provider: Promise<BillingProvider> } | null = null;

/**
 * The provider in use, built once; `null` while billing is off. A build that
 * throws is not kept, so the next call tries again.
 */
export async function billingProvider(): Promise<BillingProvider | null> {
  const state = billingProviderState();
  if (!state.on) return null;
  if (built?.key === state.providerKey) return built.provider;
  const key = state.providerKey;
  const provider = buildProvider(key);
  built = { key, provider };
  provider.catch(() => {
    if (built?.provider === provider) built = null;
  });
  return provider;
}

async function buildProvider(key: string): Promise<BillingProvider> {
  if (key === STRIPE_PROVIDER_KEY) {
    // The one place the adapter (and so the SDK) is loaded.
    const { createStripeProvider } = await import('@/lib/billing/providers/stripe');
    const secretKey = env.STRIPE_SECRET_KEY;
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!secretKey || !webhookSecret) throw new Error('Stripe is not configured');
    return createStripeProvider({ secretKey, webhookSecret });
  }
  const registration = billingProviderRegistry().get(key);
  if (!registration) throw new Error(`No billing provider is registered as "${key}"`);
  const provider = await registration.create();
  if (provider.key !== key) {
    throw new Error(`Billing provider registered as "${key}" reports its key as "${provider.key}"`);
  }
  return provider;
}

/** Test-only: forget the built provider. */
export function __resetBillingProviderForTests(): void {
  built = null;
}
